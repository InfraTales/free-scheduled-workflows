/**
 * The one Lambda function in the nightly workflow.
 *
 * It reads the day's orders page by page and adds them up, inside a single invocation,
 * until it runs out of pages or out of time. Doing the loop here instead of in Step
 * Functions is the point: each page costs no state transitions. Step Functions only
 * loops (Summarize -> MorePages? -> Summarize) when one invocation can't finish in time.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Context } from 'aws-lambda';
import { intEnv, requireEnv } from './config';
import { isDay, reportDay } from './days';

export interface Totals {
  orders: number;
  amountCents: number;
  byStatus: Record<string, number>;
  pages: number;
}

export interface SummarizeInput {
  /** From EventBridge Scheduler: <aws.scheduler.scheduled-time>. */
  scheduledTime?: string;
  /** Set on loop rounds, or by hand to re-run a past day. */
  day?: string;
  cursor?: string | null;
  totals?: Totals;
  round?: number;
}

export interface SummarizeOutput {
  day: string;
  totals: Totals;
  /** Where the next round starts, or null when every page is counted. */
  cursor: string | null;
  round: number;
}

/** Thrown when a run needs more rounds than MAX_ROUNDS. Step Functions catches it and fails the run. */
export class TooManyRoundsError extends Error {
  constructor(rounds: number) {
    super(`still not finished after ${rounds} rounds`);
    this.name = 'TooManyRounds';
  }
}

export const STATUS = /^[A-Z_]{1,32}$/;

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export function dayKey(day: string): string {
  return `DAY#${day}`;
}

export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

export function decodeCursor(cursor: string, day: string): Record<string, unknown> {
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('cursor is not valid');
  }
  // A cursor may only point inside the day being counted.
  if (
    typeof key !== 'object' || key === null || Array.isArray(key) ||
    (key as Record<string, unknown>).pk !== dayKey(day) ||
    typeof (key as Record<string, unknown>).sk !== 'string' ||
    Object.keys(key).length !== 2
  ) {
    throw new Error('cursor is not valid');
  }
  return key as Record<string, unknown>;
}

function emptyTotals(): Totals {
  return { orders: 0, amountCents: 0, byStatus: {}, pages: 0 };
}

function checkTotals(t: unknown): Totals {
  const ok =
    typeof t === 'object' && t !== null &&
    Number.isSafeInteger((t as Totals).orders) && (t as Totals).orders >= 0 &&
    Number.isSafeInteger((t as Totals).amountCents) &&
    Number.isSafeInteger((t as Totals).pages) && (t as Totals).pages >= 0 &&
    typeof (t as Totals).byStatus === 'object' && (t as Totals).byStatus !== null &&
    Object.entries((t as Totals).byStatus).every(([k, v]) => STATUS.test(k) && Number.isSafeInteger(v) && v >= 0);
  if (!ok) throw new Error('totals are not valid');
  return t as Totals;
}

export interface Settings {
  tableName: string;
  timeZone: string;
  pageSize: number;
  maxRounds: number;
  /** Stop starting new pages when the invocation has less than this left. */
  reserveMs: number;
}

export function settingsFromEnv(): Settings {
  return {
    tableName: requireEnv('TABLE_NAME'),
    timeZone: requireEnv('TIME_ZONE'),
    pageSize: intEnv('PAGE_SIZE', 500, 1, 1000),
    maxRounds: intEnv('MAX_ROUNDS', 5, 1, 50),
    reserveMs: intEnv('RESERVE_MS', 20_000, 0, 600_000),
  };
}

export async function summarize(
  input: SummarizeInput,
  remainingMs: () => number,
  s: Settings,
): Promise<SummarizeOutput> {
  let day: string;
  if (input.day !== undefined) {
    if (!isDay(input.day)) throw new Error('day must be YYYY-MM-DD');
    day = input.day;
  } else if (typeof input.scheduledTime === 'string') {
    day = reportDay(input.scheduledTime, s.timeZone);
  } else {
    throw new Error('input needs scheduledTime or day');
  }

  const round = (input.round ?? 0) + 1;
  if (!Number.isSafeInteger(round) || round < 1) throw new Error('round is not valid');
  if (round > s.maxRounds) throw new TooManyRoundsError(s.maxRounds);

  const totals = input.totals === undefined ? emptyTotals() : checkTotals(input.totals);
  let startKey = input.cursor ? decodeCursor(input.cursor, day) : undefined;

  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: s.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': dayKey(day) },
        ProjectionExpression: '#s, amountCents',
        ExpressionAttributeNames: { '#s': 'status' },
        Limit: s.pageSize,
        ExclusiveStartKey: startKey,
      }),
    );
    totals.pages += 1;
    for (const item of page.Items ?? []) {
      totals.orders += 1;
      const amount: unknown = item.amountCents;
      if (typeof amount === 'number' && Number.isSafeInteger(amount)) totals.amountCents += amount;
      const status: unknown = item.status;
      const key = typeof status === 'string' && STATUS.test(status) ? status : 'UNKNOWN';
      totals.byStatus[key] = (totals.byStatus[key] ?? 0) + 1;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey !== undefined && remainingMs() > s.reserveMs);

  return { day, totals, cursor: startKey ? encodeCursor(startKey) : null, round };
}

let settings: Settings | undefined;

export async function handler(event: SummarizeInput, context: Context): Promise<SummarizeOutput> {
  settings ??= settingsFromEnv();
  const out = await summarize(event, () => context.getRemainingTimeInMillis(), settings);
  console.log(JSON.stringify({ msg: 'summarized', day: out.day, round: out.round, orders: out.totals.orders, more: out.cursor !== null }));
  return out;
}
