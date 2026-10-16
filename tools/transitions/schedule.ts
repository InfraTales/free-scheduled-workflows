/**
 * How many times an EventBridge Scheduler expression fires in a calendar month.
 *
 * cron(minutes hours day-of-month month day-of-week year), evaluated in a time zone,
 * with Scheduler's daylight saving rules: a run that falls in the spring-forward gap is
 * skipped, and a run in the fall-back overlap happens once. rate() ignores time zones.
 * at() fires once.
 */
import { daysInMonth, formatWall, instantsFor, isTimeZone, WallTime } from './tz';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
// AWS cron counts day-of-week from 1 = Sunday.
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export interface MonthRuns {
  runs: number;
  /** Local times the expression names that don't exist (spring forward). Scheduler skips them. */
  skipped: string[];
  /** Local times that happen twice (fall back). Scheduler runs them once. */
  repeated: string[];
  /** True for rate(), where the count depends on when the schedule started. */
  approximate: boolean;
}

function parseValue(token: string, names: string[] | undefined, offset: number): number {
  const upper = token.toUpperCase();
  if (names && names.includes(upper)) return names.indexOf(upper) + offset;
  if (!/^\d+$/.test(token)) throw new Error(`not a number: ${token}`);
  return Number(token);
}

/** Expands one cron field to the set of values it allows. `null` means "any" (* or ?). */
export function parseField(
  field: string,
  min: number,
  max: number,
  names?: string[],
  nameOffset = 1,
): Set<number> | null {
  if (field === '*' || field === '?') return null;
  // Names such as JUL and WED contain L and W, so take them out before looking.
  const withoutNames = field.toUpperCase().replace(/[A-Z]{3}/g, (m) => (names?.includes(m) ? '0' : m));
  if (/[LW#]/.test(withoutNames)) {
    throw new Error(`L, W and # in "${field}" are not supported here. Pass the run count with --runs instead.`);
  }
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range!.includes('-')) {
      const [a, b] = range!.split('-');
      lo = parseValue(a!, names, nameOffset);
      hi = parseValue(b!, names, nameOffset);
    } else {
      lo = parseValue(range!, names, nameOffset);
      hi = stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number> | null;
  months: Set<number> | null;
  daysOfWeek: Set<number> | null;
  years: Set<number> | null;
}

export function parseCron(expression: string): Cron {
  const m = /^cron\((.*)\)$/.exec(expression.trim());
  if (!m) throw new Error(`not a cron expression: ${expression}`);
  const fields = m[1]!.trim().split(/\s+/);
  if (fields.length !== 6) throw new Error(`cron needs 6 fields (minutes hours day-of-month month day-of-week year), got ${fields.length}`);
  const [min, hour, dom, mon, dow, year] = fields as [string, string, string, string, string, string];
  if ((dom === '?') === (dow === '?')) {
    throw new Error('use ? in exactly one of day-of-month and day-of-week');
  }
  const all = (s: Set<number> | null, lo: number, hi: number): Set<number> =>
    s ?? new Set(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
  return {
    minutes: all(parseField(min, 0, 59), 0, 59),
    hours: all(parseField(hour, 0, 23), 0, 23),
    daysOfMonth: parseField(dom, 1, 31),
    months: parseField(mon, 1, 12, MONTHS),
    daysOfWeek: parseField(dow, 1, 7, WEEKDAYS),
    years: parseField(year, 1970, 2199),
  };
}

const RATE = /^rate\((\d+)\s+(minutes?|hours?|days?)\)$/;

export function runsInMonth(expression: string, timeZone: string, year: number, month: number): MonthRuns {
  if (!isTimeZone(timeZone)) throw new Error(`unknown time zone: ${timeZone}`);
  const expr = expression.trim();
  const days = daysInMonth(year, month);

  const rate = RATE.exec(expr);
  if (rate) {
    const n = Number(rate[1]);
    if (n < 1) throw new Error('rate value must be positive');
    const unit = rate[2]!.replace(/s$/, '');
    const minutes = n * (unit === 'minute' ? 1 : unit === 'hour' ? 60 : 1440);
    // A month has days * 1440 minutes; a rate fires once per interval.
    return { runs: Math.floor((days * 1440) / minutes), skipped: [], repeated: [], approximate: true };
  }

  const at = /^at\((\d{4})-(\d{2})-\d{2}T\d{2}:\d{2}:\d{2}\)$/.exec(expr);
  if (at) {
    const hit = Number(at[1]) === year && Number(at[2]) === month;
    return { runs: hit ? 1 : 0, skipped: [], repeated: [], approximate: false };
  }

  const cron = parseCron(expr);
  const result: MonthRuns = { runs: 0, skipped: [], repeated: [], approximate: false };
  if (cron.years && !cron.years.has(year)) return result;
  if (cron.months && !cron.months.has(month)) return result;

  for (let day = 1; day <= days; day++) {
    if (cron.daysOfMonth && !cron.daysOfMonth.has(day)) continue;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1; // 1 = Sunday
    if (cron.daysOfWeek && !cron.daysOfWeek.has(weekday)) continue;
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const wall: WallTime = { year, month, day, hour, minute };
        const instants = instantsFor(wall, timeZone).length;
        if (instants === 0) {
          result.skipped.push(formatWall(wall));
          continue;
        }
        if (instants > 1) result.repeated.push(formatWall(wall));
        result.runs += 1; // a repeated time still runs once
      }
    }
  }
  return result;
}
