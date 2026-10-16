/**
 * Counts Step Functions Standard state transitions for one execution of a state machine.
 *
 * Billing rules this follows (AWS Step Functions pricing page, checked 2026-10-15):
 * - "Step Functions counts a state transition each time a step of your workflow is
 *   executed." We count every state entered, including Pass, Choice, Wait, Succeed and Fail.
 * - "each retry will be charged as an additional state transition."
 * - Inline Map: "there is no state transition for starting each iteration", so a Map costs
 *   one for itself plus the states inside each iteration.
 * - Distributed Map: "one state transition per iteration". Express child workflows bill as
 *   Express requests instead of transitions. For Standard children we also count their
 *   states, as each child is a Standard execution.
 *
 * A state machine can branch, so you tell the counter what one run looks like with a
 * RunProfile: which way each Choice goes, how many retries happen, how many items each
 * Map gets, and which Task fails with which error.
 */

export interface RunProfile {
  /** Choice state name -> the Next state it picks on each visit, in order. After the list runs out, Default. */
  choices?: Record<string, string[]>;
  /** Task name -> retries each time the state runs (each retry is a transition). */
  retries?: Record<string, number>;
  /** Map state name -> items per visit. */
  mapItems?: Record<string, number>;
  /** Items for any Map state not named in mapItems. Without it, an unnamed Map is an error. */
  defaultMapItems?: number;
  /**
   * Task name -> error it ends with (after any retries). The matching Catch decides what
   * runs next. A plain string fails the first visit; { error, onVisit } fails a later one.
   */
  errors?: Record<string, string | { error: string; onVisit: number }>;
}

export interface Count {
  transitions: number;
  byState: Record<string, number>;
  /** Lambda invocations, counting each retry as another invocation. */
  lambdaInvocations: number;
  /** Express child workflow runs started by Distributed Map (billed as Express, not transitions). */
  expressChildRuns: number;
  /** How the run ended. */
  outcome: 'succeeded' | 'failed';
}

type Json = Record<string, unknown>;

interface Graph {
  StartAt: string;
  States: Record<string, Json>;
}

interface Catcher {
  ErrorEquals: string[];
  Next: string;
}

interface Retrier {
  ErrorEquals: string[];
  MaxAttempts?: number;
}

const MAX_STEPS = 1_000_000;

function asGraph(value: unknown, where: string): Graph {
  const g = value as Graph;
  if (!g || typeof g.StartAt !== 'string' || typeof g.States !== 'object' || g.States === null) {
    throw new Error(`${where} needs StartAt and States`);
  }
  if (!(g.StartAt in g.States)) throw new Error(`${where}: StartAt "${g.StartAt}" is not a state`);
  return g;
}

function isLambdaTask(state: Json): boolean {
  const r = state.Resource;
  return typeof r === 'string' && (r.includes(':states:::lambda:invoke') || /:lambda:[^:]*:[^:]*:function:/.test(r));
}

class Walker {
  readonly count: Count = { transitions: 0, byState: {}, lambdaInvocations: 0, expressChildRuns: 0, outcome: 'succeeded' };
  private steps = 0;
  private readonly visits = new Map<string, number>();

  constructor(private readonly profile: RunProfile) {}

  private add(name: string, n = 1): void {
    this.count.transitions += n;
    this.count.byState[name] = (this.count.byState[name] ?? 0) + n;
  }

  /** Runs a graph to its end. Returns false if it failed with no Catch to handle it. */
  run(graph: Graph, path: string): boolean {
    const choiceQueues = new Map<string, string[]>();
    let current: string | undefined = graph.StartAt;
    while (current !== undefined) {
      if (++this.steps > MAX_STEPS) throw new Error(`more than ${MAX_STEPS} states entered: is a Choice looping forever?`);
      const name: string = current;
      const state: Json | undefined = graph.States[name];
      if (!state) throw new Error(`${path}: no state named "${name}"`);
      const label = path ? `${path}/${name}` : name;
      this.add(label);

      const type = state.Type;
      let failedWith: string | undefined;

      if (type === 'Succeed') return true;
      if (type === 'Fail') return false;

      if (type === 'Choice') {
        current = this.choose(name, state, choiceQueues);
        continue;
      }

      if (type === 'Task') {
        failedWith = this.task(name, label, state);
      } else if (type === 'Map') {
        const ok = this.map(name, label, state);
        if (!ok) failedWith = 'States.ALL';
      } else if (type === 'Parallel') {
        const branches = state.Branches as unknown[];
        if (!Array.isArray(branches)) throw new Error(`${label}: Parallel needs Branches`);
        const ok = branches.map((b, i) => this.run(asGraph(b, `${label} branch ${i}`), `${label}[${i}]`)).every(Boolean);
        if (!ok) failedWith = 'States.ALL';
      } else if (type !== 'Pass' && type !== 'Wait') {
        throw new Error(`${label}: unknown state type ${String(type)}`);
      }

      if (failedWith !== undefined) {
        const next = this.catchFor(state, failedWith);
        if (next === undefined) return false;
        current = next;
        continue;
      }
      if (state.End === true) return true;
      if (typeof state.Next !== 'string') throw new Error(`${label}: needs Next or End`);
      current = state.Next;
    }
    return true;
  }

  private choose(name: string, state: Json, queues: Map<string, string[]>): string {
    const rules = (state.Choices as Json[] | undefined) ?? [];
    const targets = new Set(rules.map((r) => r.Next as string));
    const fallback = state.Default as string | undefined;
    if (fallback) targets.add(fallback);
    if (!queues.has(name)) queues.set(name, [...(this.profile.choices?.[name] ?? [])]);
    const picked = queues.get(name)!.shift() ?? fallback;
    if (picked === undefined) throw new Error(`Choice "${name}" has no Default; say where it goes in profile.choices`);
    if (!targets.has(picked)) throw new Error(`Choice "${name}" can't go to "${picked}"`);
    return picked;
  }

  private task(name: string, label: string, state: Json): string | undefined {
    let attempts = 1;
    const retries = this.profile.retries?.[name] ?? 0;
    if (retries > 0) {
      const retriers = (state.Retry as Retrier[] | undefined) ?? [];
      const most = Math.max(0, ...retriers.map((r) => r.MaxAttempts ?? 3));
      if (retries > most) throw new Error(`"${name}" allows at most ${most} retries, profile asks for ${retries}`);
      this.add(label, retries);
      attempts += retries;
    }
    if (isLambdaTask(state)) this.count.lambdaInvocations += attempts;
    const visit = (this.visits.get(label) ?? 0) + 1;
    this.visits.set(label, visit);
    const spec = this.profile.errors?.[name];
    if (spec === undefined) return undefined;
    const { error, onVisit } = typeof spec === 'string' ? { error: spec, onVisit: 1 } : spec;
    return visit === onVisit ? error : undefined;
  }

  private map(name: string, label: string, state: Json): boolean {
    const items = this.profile.mapItems?.[name] ?? this.profile.defaultMapItems;
    if (items === undefined) throw new Error(`Map "${name}" needs an item count: set profile.mapItems or defaultMapItems`);
    const processor = asGraph(state.ItemProcessor ?? state.Iterator, `${label} ItemProcessor`);
    const config = (state.ItemProcessor as Json | undefined)?.ProcessorConfig as Json | undefined;
    if (config?.Mode === 'DISTRIBUTED') {
      this.add(`${label} (iterations)`, items);
      if (config.ExecutionType === 'EXPRESS') {
        this.count.expressChildRuns += items;
        return true;
      }
    }
    let ok = true;
    for (let i = 0; i < items; i++) ok = this.run(processor, `${label}[]`) && ok;
    return ok;
  }

  private catchFor(state: Json, error: string): string | undefined {
    const catchers = (state.Catch as Catcher[] | undefined) ?? [];
    return catchers.find((c) => c.ErrorEquals.includes(error) || c.ErrorEquals.includes('States.ALL'))?.Next;
  }
}

/** Transitions for one execution of `definition` (an ASL object) following `profile`. */
export function countTransitions(definition: unknown, profile: RunProfile = {}): Count {
  const walker = new Walker(profile);
  const ok = walker.run(asGraph(definition, 'definition'), '');
  walker.count.outcome = ok ? 'succeeded' : 'failed';
  return walker.count;
}

export const FREE_TRANSITIONS = 4_000;
/** us-east-1, AWS Price List API (AmazonStates, USE1-StateTransition), checked 2026-10-15. */
export const PRICE_PER_TRANSITION_USD = 0.000025;

export interface MonthlyBudget {
  runs: number;
  perRun: number;
  transitions: number;
  freeLeft: number;
  /** Cost if this were the only Standard workflow in the account. */
  costUsd: number;
  /** Most runs a month that fit in the free tier at this many transitions per run. */
  maxFreeRuns: number;
}

export function monthlyBudget(perRun: number, runs: number): MonthlyBudget {
  const transitions = perRun * runs;
  return {
    runs,
    perRun,
    transitions,
    freeLeft: Math.max(0, FREE_TRANSITIONS - transitions),
    costUsd: Math.round(Math.max(0, transitions - FREE_TRANSITIONS) * PRICE_PER_TRANSITION_USD * 100) / 100,
    maxFreeRuns: perRun === 0 ? Infinity : Math.floor(FREE_TRANSITIONS / perRun),
  };
}
