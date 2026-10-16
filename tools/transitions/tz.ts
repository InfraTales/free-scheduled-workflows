/**
 * Wall-clock time in an IANA time zone, using only Node's built-in Intl data.
 *
 * The one question that matters for schedules: for a given local date and time, how many
 * real instants have that wall-clock reading? Normally one. On the day clocks spring
 * forward, times inside the gap have none. On the day they fall back, times inside the
 * overlap have two.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function wallTimeAt(instantMs: number, timeZone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}

/** Minutes the zone is ahead of UTC at an instant (New York in winter: -300). */
export function offsetMinutes(instantMs: number, timeZone: string): number {
  const w = wallTimeAt(instantMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const truncated = Math.floor(instantMs / 60_000) * 60_000;
  return (asUtc - truncated) / 60_000;
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute;
}

/**
 * Every UTC instant (ms) whose wall-clock reading in `timeZone` equals `wall`, earliest
 * first. Empty inside a spring-forward gap, two entries inside a fall-back overlap.
 */
export function instantsFor(wall: WallTime, timeZone: string): number[] {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  // Offsets in force around this date. Zones change offset at most once a day.
  const offsets = new Set([
    offsetMinutes(guess - 36 * 3_600_000, timeZone),
    offsetMinutes(guess, timeZone),
    offsetMinutes(guess + 36 * 3_600_000, timeZone),
  ]);
  const found = new Set<number>();
  for (const o of offsets) {
    const t = guess - o * 60_000;
    if (sameWall(wallTimeAt(t, timeZone), wall)) found.add(t);
  }
  return [...found].sort((a, b) => a - b);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatWall(w: WallTime): string {
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * Days in `year` when a daily job at hour:minute local time would be skipped (spring
 * gap) or would land in the repeated hour (fall overlap). EventBridge Scheduler skips
 * the first and runs the second once.
 */
export function dstProblems(
  hour: number,
  minute: number,
  timeZone: string,
  year: number,
): { skipped: string[]; repeated: string[] } {
  const skipped: string[] = [];
  const repeated: string[] = [];
  for (let month = 1; month <= 12; month++) {
    for (let day = 1; day <= daysInMonth(year, month); day++) {
      const wall = { year, month, day, hour, minute };
      const n = instantsFor(wall, timeZone).length;
      if (n === 0) skipped.push(formatWall(wall));
      if (n > 1) repeated.push(formatWall(wall));
    }
  }
  return { skipped, repeated };
}
