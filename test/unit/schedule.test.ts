import { parseCron, runsInMonth } from '../../tools/transitions/schedule';
import { dstProblems, instantsFor, offsetMinutes } from '../../tools/transitions/tz';
import { checkSchedule, DEFAULT_SCHEDULE } from '../../infra/lib/schedule-config';

describe('runsInMonth', () => {
  test('daily at 03:30 New York runs every day of March 2026 (31)', () => {
    const r = runsInMonth('cron(30 3 * * ? *)', 'America/New_York', 2026, 3);
    expect(r).toEqual({ runs: 31, skipped: [], repeated: [], approximate: false });
  });

  test('daily at 02:30 New York misses 8 March 2026, when clocks jump from 02:00 to 03:00', () => {
    const r = runsInMonth('cron(30 2 * * ? *)', 'America/New_York', 2026, 3);
    expect(r.runs).toBe(30);
    expect(r.skipped).toEqual(['2026-03-08 02:30']);
  });

  test('daily at 01:30 New York runs once on 1 November 2026, though 01:30 happens twice', () => {
    const r = runsInMonth('cron(30 1 * * ? *)', 'America/New_York', 2026, 11);
    expect(r.runs).toBe(30);
    expect(r.repeated).toEqual(['2026-11-01 01:30']);
  });

  test('UTC has no daylight saving: 02:30 UTC runs all 31 days of March', () => {
    expect(runsInMonth('cron(30 2 * * ? *)', 'UTC', 2026, 3).runs).toBe(31);
  });

  test('London skips 01:30 on 29 March 2026', () => {
    expect(runsInMonth('cron(30 1 * * ? *)', 'Europe/London', 2026, 3).skipped).toEqual(['2026-03-29 01:30']);
  });

  test('day-of-week 1 is Sunday: Sundays in October 2026 are the 4th, 11th, 18th and 25th', () => {
    expect(runsInMonth('cron(0 9 ? * 1 *)', 'UTC', 2026, 10).runs).toBe(4);
    expect(runsInMonth('cron(0 9 ? * SUN *)', 'UTC', 2026, 10).runs).toBe(4);
  });

  test('weekdays MON-FRI in October 2026: 22', () => {
    expect(runsInMonth('cron(0 9 ? * MON-FRI *)', 'UTC', 2026, 10).runs).toBe(22);
  });

  test('every 15 minutes in business hours on weekdays: 4 x 9 x 22 = 792', () => {
    expect(runsInMonth('cron(0/15 9-17 ? * MON-FRI *)', 'UTC', 2026, 10).runs).toBe(792);
  });

  test('month and year fields filter whole months', () => {
    expect(runsInMonth('cron(0 6 1 JUL ? 2026)', 'UTC', 2026, 7).runs).toBe(1);
    expect(runsInMonth('cron(0 6 1 JUL ? 2026)', 'UTC', 2026, 8).runs).toBe(0);
    expect(runsInMonth('cron(0 6 1 JUL ? 2027)', 'UTC', 2026, 7).runs).toBe(0);
  });

  test('rate(1 hour) in February 2026: 28 x 24 = 672', () => {
    expect(runsInMonth('rate(1 hour)', 'UTC', 2026, 2)).toMatchObject({ runs: 672, approximate: true });
    expect(runsInMonth('rate(5 minutes)', 'UTC', 2026, 2).runs).toBe(8064);
  });

  test('at() runs once, in its own month only', () => {
    expect(runsInMonth('at(2026-10-31T09:00:00)', 'UTC', 2026, 10).runs).toBe(1);
    expect(runsInMonth('at(2026-10-31T09:00:00)', 'UTC', 2026, 11).runs).toBe(0);
  });
});

describe('parseCron', () => {
  test('needs ? in exactly one of day-of-month and day-of-week', () => {
    expect(() => parseCron('cron(0 9 * * * *)')).toThrow('exactly one');
    expect(() => parseCron('cron(0 9 ? * ? *)')).toThrow('exactly one');
  });

  test('needs six fields', () => {
    expect(() => parseCron('cron(0 9 * * ?)')).toThrow('6 fields');
  });

  test('refuses L, W and # instead of miscounting them', () => {
    expect(() => parseCron('cron(0 9 L * ? *)')).toThrow('not supported');
    expect(() => parseCron('cron(0 9 ? * 6#3 *)')).toThrow('not supported');
  });

  test('month and weekday names that contain L or W still parse', () => {
    expect(parseCron('cron(0 9 ? JUL WED *)').months).toEqual(new Set([7]));
  });

  test('values outside the range are errors', () => {
    expect(() => parseCron('cron(60 9 * * ? *)')).toThrow('outside');
  });
});

describe('time zone helpers', () => {
  test('New York is UTC-5 in January and UTC-4 in July', () => {
    expect(offsetMinutes(Date.UTC(2026, 0, 15), 'America/New_York')).toBe(-300);
    expect(offsetMinutes(Date.UTC(2026, 6, 15), 'America/New_York')).toBe(-240);
  });

  test('a fall-back time has two instants, an hour apart', () => {
    const [a, b] = instantsFor({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
    expect(b! - a!).toBe(3_600_000);
  });

  test('dstProblems finds both New York changes for a 02:30 and a 01:30 job', () => {
    expect(dstProblems(2, 30, 'America/New_York', 2026)).toEqual({ skipped: ['2026-03-08 02:30'], repeated: [] });
    expect(dstProblems(1, 30, 'America/New_York', 2026)).toEqual({ skipped: [], repeated: ['2026-11-01 01:30'] });
    expect(dstProblems(2, 30, 'Asia/Kolkata', 2026)).toEqual({ skipped: [], repeated: [] });
  });
});

describe('checkSchedule', () => {
  test('the default 03:30 New York schedule passes for 2026-2028', () => {
    expect(() => checkSchedule(DEFAULT_SCHEDULE, [2026, 2027, 2028])).not.toThrow();
  });

  test('02:30 New York is refused', () => {
    expect(() => checkSchedule({ ...DEFAULT_SCHEDULE, hour: 2 }, [2026])).toThrow('skipped: 2026-03-08 02:30');
  });

  test('01:30 New York is refused too, because it lands in the repeated hour', () => {
    expect(() => checkSchedule({ ...DEFAULT_SCHEDULE, hour: 1 }, [2026])).toThrow('repeated: 2026-11-01 01:30');
  });

  test('bad values are refused', () => {
    expect(() => checkSchedule({ ...DEFAULT_SCHEDULE, timeZone: 'Mars/Olympus' }, [2026])).toThrow('unknown time zone');
    expect(() => checkSchedule({ ...DEFAULT_SCHEDULE, retryAttempts: 186 }, [2026])).toThrow('0-185');
    expect(() => checkSchedule({ ...DEFAULT_SCHEDULE, maxEventAgeSeconds: 30 }, [2026])).toThrow('60-86400');
    expect(() => checkSchedule({ ...DEFAULT_SCHEDULE, flexibleWindowMinutes: 1441 }, [2026])).toThrow('0-1440');
  });
});
