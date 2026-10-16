/**
 * Every expected number here is worked out by hand in the comment above it.
 */
import { countTransitions, monthlyBudget } from '../../tools/transitions/counter';
import naiveMap from '../../examples/naive-map.asl.json';
import hourly from '../../examples/hourly-six-steps.asl.json';

const fn = (name: string) => `arn:aws:lambda:us-east-1:123456789012:function:${name}`;

// Same shape as the deployed workflow: Summarize -> MorePages? -> SaveReport.
const nightly = {
  StartAt: 'Summarize',
  States: {
    Summarize: {
      Type: 'Task',
      Resource: fn('summarize'),
      Retry: [{ ErrorEquals: ['Lambda.ServiceException'], MaxAttempts: 2 }],
      Catch: [{ ErrorEquals: ['States.ALL'], Next: 'JobFailed' }],
      Next: 'MorePages?',
    },
    'MorePages?': {
      Type: 'Choice',
      Choices: [{ Variable: '$.cursor', IsNull: false, Next: 'Summarize' }],
      Default: 'SaveReport',
    },
    SaveReport: {
      Type: 'Task',
      Resource: 'arn:aws:states:::dynamodb:putItem',
      Catch: [
        { ErrorEquals: ['DynamoDB.ConditionalCheckFailedException'], Next: 'AlreadyReported' },
        { ErrorEquals: ['States.ALL'], Next: 'JobFailed' },
      ],
      End: true,
    },
    AlreadyReported: { Type: 'Succeed' },
    JobFailed: { Type: 'Fail' },
  },
};

describe('the nightly workflow', () => {
  test('a normal night: Summarize, MorePages?, SaveReport = 3', () => {
    const c = countTransitions(nightly);
    expect(c.transitions).toBe(3);
    expect(c.byState).toEqual({ Summarize: 1, 'MorePages?': 1, SaveReport: 1 });
    expect(c.lambdaInvocations).toBe(1);
    expect(c.outcome).toBe('succeeded');
  });

  test('two rounds: (Summarize + MorePages?) x 2 + SaveReport = 5', () => {
    const c = countTransitions(nightly, { choices: { 'MorePages?': ['Summarize'] } });
    expect(c.transitions).toBe(5);
    expect(c.lambdaInvocations).toBe(2);
  });

  test('each retry is one more transition: 3 + 2 retries = 5, and 3 Lambda calls', () => {
    const c = countTransitions(nightly, { retries: { Summarize: 2 } });
    expect(c.transitions).toBe(5);
    expect(c.byState.Summarize).toBe(3);
    expect(c.lambdaInvocations).toBe(3);
  });

  test('a profile cannot ask for more retries than the Retry block allows', () => {
    expect(() => countTransitions(nightly, { retries: { Summarize: 3 } })).toThrow('at most 2 retries');
  });

  test('a repeat run: 3 + AlreadyReported = 4, still a success', () => {
    const c = countTransitions(nightly, { errors: { SaveReport: 'DynamoDB.ConditionalCheckFailedException' } });
    expect(c.transitions).toBe(4);
    expect(c.outcome).toBe('succeeded');
  });

  test('a failure: Summarize + JobFailed = 2, and the run fails', () => {
    const c = countTransitions(nightly, { errors: { Summarize: 'Lambda.Unknown' } });
    expect(c.transitions).toBe(2);
    expect(c.outcome).toBe('failed');
  });
});

describe('Map', () => {
  test('inline Map: 1 for the Map, nothing to start each iteration, states inside count', () => {
    // ListOrders 1 + ForEachOrder 1 + 200 x (LoadOrder, IsRefund?, CountSale) 600 + SaveReport 1 = 603
    const c = countTransitions(naiveMap, { mapItems: { ForEachOrder: 200 } });
    expect(c.transitions).toBe(603);
    expect(c.byState['ForEachOrder[]/LoadOrder']).toBe(200);
  });

  test('choices inside a Map apply per iteration', () => {
    // 1 + 1 + 2 x 3 + 1 = 9; both iterations take CountRefund
    const c = countTransitions(naiveMap, { mapItems: { ForEachOrder: 2 }, choices: { 'IsRefund?': ['CountRefund'] } });
    expect(c.transitions).toBe(9);
    expect(c.byState['ForEachOrder[]/CountRefund']).toBe(2);
  });

  test('a Map with no item count is an error, not a silent zero', () => {
    expect(() => countTransitions(naiveMap)).toThrow('needs an item count');
  });

  test('distributed Map with Express children: 1 + 1 per iteration, children billed as Express', () => {
    const def = {
      StartAt: 'Fan',
      States: {
        Fan: {
          Type: 'Map',
          ItemProcessor: {
            ProcessorConfig: { Mode: 'DISTRIBUTED', ExecutionType: 'EXPRESS' },
            StartAt: 'Work',
            States: { Work: { Type: 'Task', Resource: fn('work'), Next: 'Done' }, Done: { Type: 'Succeed' } },
          },
          End: true,
        },
      },
    };
    const c = countTransitions(def, { mapItems: { Fan: 1000 } });
    expect(c.transitions).toBe(1001);
    expect(c.expressChildRuns).toBe(1000);
  });

  test('distributed Map with Standard children also counts the child states', () => {
    // 1 + 10 iterations + 10 x (Work, Done) = 31
    const def = {
      StartAt: 'Fan',
      States: {
        Fan: {
          Type: 'Map',
          ItemProcessor: {
            ProcessorConfig: { Mode: 'DISTRIBUTED', ExecutionType: 'STANDARD' },
            StartAt: 'Work',
            States: { Work: { Type: 'Task', Resource: fn('work'), Next: 'Done' }, Done: { Type: 'Succeed' } },
          },
          End: true,
        },
      },
    };
    expect(countTransitions(def, { mapItems: { Fan: 10 } }).transitions).toBe(31);
  });
});

describe('other state types', () => {
  test('Parallel: 1 + each branch', () => {
    // Both 1 + A (2) + B (1) + After 1 = 5
    const def = {
      StartAt: 'Both',
      States: {
        Both: {
          Type: 'Parallel',
          Branches: [
            { StartAt: 'A1', States: { A1: { Type: 'Pass', Next: 'A2' }, A2: { Type: 'Pass', End: true } } },
            { StartAt: 'B1', States: { B1: { Type: 'Wait', Seconds: 1, End: true } } },
          ],
          Next: 'After',
        },
        After: { Type: 'Pass', End: true },
      },
    };
    expect(countTransitions(def).transitions).toBe(5);
  });

  test('six chained Lambda steps = 6 per run, 4,464 in an hourly 31-day month', () => {
    const c = countTransitions(hourly);
    expect(c.transitions).toBe(6);
    const m = monthlyBudget(c.transitions, 24 * 31);
    expect(m.transitions).toBe(4464);
    expect(m.freeLeft).toBe(0);
    // (4,464 - 4,000) x $0.000025 = $0.0116
    expect(m.costUsd).toBe(0.01);
  });

  test('a Choice with no Default needs a decision in the profile', () => {
    const def = {
      StartAt: 'C',
      States: { C: { Type: 'Choice', Choices: [{ Variable: '$.x', IsPresent: true, Next: 'D' }] }, D: { Type: 'Succeed' } },
    };
    expect(() => countTransitions(def)).toThrow('has no Default');
    expect(countTransitions(def, { choices: { C: ['D'] } }).transitions).toBe(2);
  });

  test('a Choice can only go where the definition allows', () => {
    expect(() => countTransitions(nightly, { choices: { 'MorePages?': ['JobFailed'] } })).toThrow("can't go to");
  });

  test('a loop with no way out stops with an error instead of hanging', () => {
    const def = { StartAt: 'Loop', States: { Loop: { Type: 'Pass', Next: 'Loop' } } };
    expect(() => countTransitions(def)).toThrow('looping forever');
  });
});

describe('monthly budget', () => {
  test('3 per run x 31 nights = 93, leaving 3,907 free, room for 1,333 runs', () => {
    expect(monthlyBudget(3, 31)).toEqual({ runs: 31, perRun: 3, transitions: 93, freeLeft: 3907, costUsd: 0, maxFreeRuns: 1333 });
  });

  test('603 per run x 31 nights = 18,693, or $0.37 over the free tier', () => {
    // (18,693 - 4,000) x 0.000025 = 0.367
    expect(monthlyBudget(603, 31).costUsd).toBe(0.37);
  });
});

describe('errors on a later visit', () => {
  test('failing the third round: 3 x Summarize + 2 x MorePages? + JobFailed = 6', () => {
    const c = countTransitions(nightly, {
      choices: { 'MorePages?': ['Summarize', 'Summarize'] },
      errors: { Summarize: { error: 'TooManyRounds', onVisit: 3 } },
    });
    expect(c.transitions).toBe(6);
    expect(c.outcome).toBe('failed');
  });

  test('retries apply on every visit: 2 rounds with 1 retry each = 3 + 2 + 2 = 7', () => {
    const c = countTransitions(nightly, { choices: { 'MorePages?': ['Summarize'] }, retries: { Summarize: 1 } });
    expect(c.transitions).toBe(7);
    expect(c.lambdaInvocations).toBe(4);
  });
});
