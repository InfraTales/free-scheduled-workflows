/**
 * How many Step Functions state transitions a scheduled workflow uses in a month.
 *
 *   npm run count -- --definition build/nightly-digest.asl.json \
 *     --schedule "cron(30 3 * * ? *)" --tz America/New_York --month 2026-03 \
 *     [--profile examples/profiles/two-pages.json] [--runs 31]
 *
 * --profile describes one run (see tools/transitions/counter.ts). --runs overrides the
 * run count worked out from --schedule.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { countTransitions, FREE_TRANSITIONS, monthlyBudget, RunProfile } from '../tools/transitions/counter';
import { runsInMonth } from '../tools/transitions/schedule';

const { values } = parseArgs({
  options: {
    definition: { type: 'string' },
    profile: { type: 'string' },
    schedule: { type: 'string' },
    tz: { type: 'string', default: 'UTC' },
    month: { type: 'string' },
    runs: { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!values.definition) fail('--definition is required');
const definition: unknown = JSON.parse(readFileSync(values.definition, 'utf8'));
const profile = (values.profile ? JSON.parse(readFileSync(values.profile, 'utf8')) : {}) as RunProfile;

let runs: number;
let note = '';
if (values.runs !== undefined) {
  runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 0) fail('--runs must be a whole number');
} else {
  if (!values.schedule || !values.month) fail('give --schedule and --month, or --runs');
  const m = /^(\d{4})-(\d{2})$/.exec(values.month);
  if (!m) fail('--month must look like 2026-03');
  const r = runsInMonth(values.schedule, values.tz, Number(m[1]), Number(m[2]));
  runs = r.runs;
  if (r.approximate) note += '\nrate() count is approximate: it depends on when the schedule started.';
  if (r.skipped.length) note += `\nSkipped by daylight saving time (Scheduler won't run these): ${r.skipped.join(', ')}`;
  if (r.repeated.length) note += `\nIn the repeated hour (Scheduler runs these once): ${r.repeated.join(', ')}`;
}

const one = countTransitions(definition, profile);
const month = monthlyBudget(one.transitions, runs);

console.log('One run');
for (const [state, n] of Object.entries(one.byState)) console.log(`  ${state.padEnd(40)} ${n}`);
console.log(`  ${'total'.padEnd(40)} ${one.transitions} (${one.outcome})`);
console.log(`\nRuns this month: ${runs}`);
console.log(`Transitions this month: ${month.transitions} of ${FREE_TRANSITIONS} free (${month.freeLeft} left)`);
console.log(`Cost above the free tier, if this is the only Standard workflow: $${month.costUsd.toFixed(2)}`);
console.log(`Most runs a month that stay free: ${month.maxFreeRuns}`);
console.log(`Lambda invocations this month: ${one.lambdaInvocations * runs}`);
if (one.expressChildRuns) console.log(`Express child runs this month: ${one.expressChildRuns * runs} (billed as Express)`);
if (note) console.log(note);
