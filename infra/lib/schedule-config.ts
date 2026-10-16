import { dstProblems, isTimeZone } from '../../tools/transitions/tz';

export interface ScheduleConfig {
  /** IANA time zone the cron runs in. */
  timeZone: string;
  hour: number;
  minute: number;
  /** Scheduler may start the run up to this many minutes late. 0 turns the window off. */
  flexibleWindowMinutes: number;
  /** Scheduler retries when Step Functions refuses StartExecution. 0-185. */
  retryAttempts: number;
  /** Scheduler gives up (and writes to the DLQ) after this long. 60-86,400 seconds. */
  maxEventAgeSeconds: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  timeZone: 'America/New_York',
  // 03:30 exists exactly once every day in New York. 02:30 would be skipped one night a year.
  hour: 3,
  minute: 30,
  flexibleWindowMinutes: 15,
  retryAttempts: 3,
  maxEventAgeSeconds: 2 * 3600,
};

/**
 * Refuses a schedule that daylight saving time would break. Scheduler skips a run whose
 * local time doesn't exist (spring forward), so a 02:30 job in New York silently misses
 * one night a year. We'd rather fail at synth than find the gap in the reports.
 */
export function checkSchedule(c: ScheduleConfig, years: number[]): void {
  if (!isTimeZone(c.timeZone)) throw new Error(`unknown time zone: ${c.timeZone}`);
  if (!Number.isInteger(c.hour) || c.hour < 0 || c.hour > 23) throw new Error('hour must be 0-23');
  if (!Number.isInteger(c.minute) || c.minute < 0 || c.minute > 59) throw new Error('minute must be 0-59');
  if (!Number.isInteger(c.flexibleWindowMinutes) || c.flexibleWindowMinutes < 0 || c.flexibleWindowMinutes > 1440) {
    throw new Error('flexibleWindowMinutes must be 0-1440');
  }
  if (!Number.isInteger(c.retryAttempts) || c.retryAttempts < 0 || c.retryAttempts > 185) {
    throw new Error('retryAttempts must be 0-185');
  }
  if (!Number.isInteger(c.maxEventAgeSeconds) || c.maxEventAgeSeconds < 60 || c.maxEventAgeSeconds > 86_400) {
    throw new Error('maxEventAgeSeconds must be 60-86400');
  }
  for (const year of years) {
    const { skipped, repeated } = dstProblems(c.hour, c.minute, c.timeZone, year);
    if (skipped.length > 0 || repeated.length > 0) {
      throw new Error(
        `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')} in ${c.timeZone} ` +
          `is hit by daylight saving time (skipped: ${skipped.join(', ') || 'none'}; ` +
          `repeated: ${repeated.join(', ') || 'none'}). Pick a time outside the change.`,
      );
    }
  }
}
