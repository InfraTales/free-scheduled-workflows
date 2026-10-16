/**
 * Which calendar day a nightly run reports on.
 *
 * The answer comes from the time the run was *scheduled* for, never from the clock when
 * the code runs. A run that starts late (flexible window, Scheduler retries, a Step
 * Functions retry) still reports on the same day.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar date (YYYY-MM-DD) of an instant in an IANA time zone. */
export function localDate(instant: Date, timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The day before `day`, as YYYY-MM-DD. Pure calendar arithmetic, so no time zone applies. */
export function previousDay(day: string): string {
  if (!DAY.test(day)) throw new Error(`expected YYYY-MM-DD, got ${JSON.stringify(day)}`);
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The run scheduled at `scheduledTime` reports on the previous local day. */
export function reportDay(scheduledTime: string, timeZone: string): string {
  const instant = new Date(scheduledTime);
  if (Number.isNaN(instant.getTime())) {
    throw new Error(`scheduledTime is not a date: ${JSON.stringify(scheduledTime)}`);
  }
  return previousDay(localDate(instant, timeZone));
}

export function isDay(value: unknown): value is string {
  return typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}
