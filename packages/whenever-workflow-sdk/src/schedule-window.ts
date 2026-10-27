import type { ScheduleWindow } from "./types";

export interface ScheduleWindowOptions {
  /**
   * Runs each occurrence at a time picked inside this window after its scheduled time, so the
   * time differs from one occurrence to the next. Written as `"<n>m"`, `"<n>h"` or `"<n>d"` of
   * the schedule's local clock, up to the time between two runs and at most 31 days:
   * `daily({ key: "post", at: "08:00", within: "1h" })` runs once a day between 08:00 and 09:00.
   */
  within?: string;
  /**
   * Only picks times inside these hours of the day, in the schedule's time zone. `from` may be
   * later than `to` to cross midnight. Needs `within`, and is not accepted by `once`:
   * `weekly({ key: "check-in", day: "monday", at: "00:00", within: "5d", during: { from: "09:00", to: "17:00" } })`
   * runs once a week at a random time during working hours, Monday to Friday.
   */
  during?: { from: string; to: string };
  /**
   * Runs this many times in each window, from 1 to 24. The window is split into equal parts and
   * one time is picked in each, so the runs spread out. Needs `within`.
   */
  times?: number;
}

export const MAX_WINDOW_MINUTES = 31 * 24 * 60;
export const MAX_WINDOW_TIMES = 24;

const DAY_MINUTES = 24 * 60;
const UNIT_MINUTES: Readonly<Record<string, number>> = { m: 1, h: 60, d: DAY_MINUTES };
const ALIAS_CRONS: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

export function parseTimeOfDay(at: string): { hour: number; minute: number } {
  const normalized = at.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (match === null) {
    const withSeconds = /^(\d{1,2}:\d{2}):\d{2}$/.exec(normalized);
    if (withSeconds !== null) {
      throw new Error(
        `invalid time "${at}": schedules have minute granularity, so a seconds component cannot be honored — use "${withSeconds[1]}"`,
      );
    }
    throw new Error(`invalid time "${at}": expected "HH:MM" (24-hour)`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(
      `invalid time "${at}": hour must be 0-23 and minute must be 0-59`,
    );
  }
  return { hour, minute };
}

function formatTimeOfDay({ hour, minute }: { hour: number; minute: number }): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatMinutes(minutes: number): string {
  if (minutes % DAY_MINUTES === 0) return `${String(minutes / DAY_MINUTES)}d`;
  if (minutes % 60 === 0) return `${String(minutes / 60)}h`;
  return `${String(minutes)}m`;
}

function windowMinutes(within: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(within.trim());
  const minutes = match === null ? Number.NaN : Number(match[1]) * UNIT_MINUTES[match[2]];
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WINDOW_MINUTES) {
    throw new Error(
      `invalid window "${within}": expected "<n>m", "<n>h" or "<n>d" from 1 minute to 31 days, such as "30m", "2h" or "5d"`,
    );
  }
  return minutes;
}

function fieldValues(field: string, minimum: number, maximum: number): number[] | undefined {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    if (match === null) return undefined;
    const wildcard = match[1] === "*";
    if (wildcard && match[2] !== undefined) return undefined;
    const step = match[3] === undefined ? 1 : Number(match[3]);
    const start = wildcard ? minimum : Number(match[1]);
    const end = wildcard || (match[2] === undefined && match[3] !== undefined)
      ? maximum
      : match[2] === undefined
        ? start
        : Number(match[2]);
    if (step < 1 || start < minimum || end > maximum || start > end) return undefined;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((left, right) => left - right);
}

interface CronShape {
  // Minutes after midnight at which the cron fires on a day it fires.
  readonly times: number[];
  readonly gapMinutes: number;
}

// The shortest time between two firings on the local clock, over eight calendar years so leap
// days and every month length occur. Any day field other than a bare "*" counts as set, and two
// set day fields are read as either matching; both only shorten the gap, which keeps windows apart.
function cronShape(cron: string): CronShape | undefined {
  const fields = cron.split(/\s+/);
  if (fields.length !== 5) return undefined;
  const minutes = fieldValues(fields[0], 0, 59);
  const hours = fieldValues(fields[1], 0, 23);
  const daysOfMonth = fieldValues(fields[2], 1, 31);
  const months = fieldValues(fields[3], 1, 12);
  const daysOfWeek = fieldValues(fields[4], 0, 7)?.map((day) => day % 7);
  if (minutes === undefined || hours === undefined || daysOfMonth === undefined || months === undefined || daysOfWeek === undefined) {
    return undefined;
  }
  const times = hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute));
  const anyDayOfMonth = fields[2] === "*";
  const anyDayOfWeek = fields[4] === "*";
  const matchingDays: number[] = [];
  const first = Date.UTC(2024, 0, 1);
  for (let day = 0; day < 8 * 366; day += 1) {
    const date = new Date(first + day * DAY_MINUTES * 60_000);
    if (!months.includes(date.getUTCMonth() + 1)) continue;
    const byMonthDay = daysOfMonth.includes(date.getUTCDate());
    const byWeekDay = daysOfWeek.includes(date.getUTCDay());
    const matches = anyDayOfMonth && anyDayOfWeek
      ? true
      : anyDayOfMonth
        ? byWeekDay
        : anyDayOfWeek
          ? byMonthDay
          : byMonthDay || byWeekDay;
    if (matches) matchingDays.push(day);
  }
  let gapMinutes = Number.POSITIVE_INFINITY;
  for (let index = 1; index < times.length; index += 1) {
    gapMinutes = Math.min(gapMinutes, times[index] - times[index - 1]);
  }
  const spread = times[times.length - 1] - times[0];
  for (let index = 1; index < matchingDays.length; index += 1) {
    gapMinutes = Math.min(gapMinutes, (matchingDays[index] - matchingDays[index - 1]) * DAY_MINUTES - spread);
  }
  return { times, gapMinutes };
}

function inDuring(minuteOfDay: number, from: number, to: number): boolean {
  return from < to ? minuteOfDay >= from && minuteOfDay < to : minuteOfDay >= from || minuteOfDay < to;
}

function lowerWindow(
  options: ScheduleWindowOptions,
  maxMinutes: number,
  describe: string,
  starts: readonly number[],
): ScheduleWindow | undefined {
  if (options.within === undefined) {
    if (options.during !== undefined || options.times !== undefined) {
      throw new Error(`"during" and "times" need "within", the window to pick times in`);
    }
    return undefined;
  }
  const minutes = windowMinutes(options.within);
  if (minutes > maxMinutes) {
    throw new Error(
      `invalid window "${options.within}" for ${describe}: a window can be at most ${formatMinutes(maxMinutes)}, the time between two of its runs`,
    );
  }
  const times = options.times ?? 1;
  if (!Number.isInteger(times) || times < 1 || times > MAX_WINDOW_TIMES) {
    throw new Error(`invalid times "${String(options.times)}": expected a whole number from 1 to ${String(MAX_WINDOW_TIMES)}`);
  }
  let during: ScheduleWindow["during"];
  if (options.during !== undefined) {
    const from = parseTimeOfDay(options.during.from);
    const to = parseTimeOfDay(options.during.to);
    const fromMinute = from.hour * 60 + from.minute;
    const toMinute = to.hour * 60 + to.minute;
    if (fromMinute === toMinute) {
      throw new Error(`invalid during: "from" and "to" are the same time, so no time is allowed`);
    }
    during = { from: formatTimeOfDay(from), to: formatTimeOfDay(to) };
    const allowed = starts.map((start) => {
      let count = 0;
      for (let offset = 0; offset < minutes; offset += 1) {
        if (inDuring((start + offset) % DAY_MINUTES, fromMinute, toMinute)) count += 1;
      }
      return count;
    });
    if (allowed.every((count) => count === 0)) {
      throw new Error(
        `invalid during for ${describe}: no time between ${during.from} and ${during.to} falls inside any ${formatMinutes(minutes)} window`,
      );
    }
    const fewest = Math.min(...allowed.filter((count) => count > 0));
    if (times > fewest) {
      throw new Error(
        `invalid times "${String(times)}": a window has room for only ${String(fewest)} runs between ${during.from} and ${during.to}`,
      );
    }
  }
  if (times > minutes) {
    throw new Error(`invalid times "${String(times)}": a ${formatMinutes(minutes)} window has room for at most ${String(minutes)} runs`);
  }
  return {
    minutes,
    ...(during === undefined ? {} : { during }),
    ...(times === 1 ? {} : { times }),
  };
}

export function recurringWindow(cron: string, options: ScheduleWindowOptions): ScheduleWindow | undefined {
  const describe = `cron "${cron}"`;
  if (options.within === undefined) return lowerWindow(options, MAX_WINDOW_MINUTES, describe, []);
  const shape = cronShape(ALIAS_CRONS[cron] ?? cron);
  if (shape === undefined) {
    throw new Error(
      `invalid ${describe} for a window: use numbers, "*", ranges, steps and lists only, or a builder such as daily, weekly or monthly`,
    );
  }
  return lowerWindow(options, Math.min(shape.gapMinutes, MAX_WINDOW_MINUTES), describe, shape.times);
}

export function onceWindow(at: string, options: ScheduleWindowOptions): ScheduleWindow | undefined {
  if (options.during !== undefined) {
    throw new Error(`"during" needs a time zone, which a one-time run has none of; set its window with "at" and "within"`);
  }
  return lowerWindow(options, MAX_WINDOW_MINUTES, `the one-time run at "${at}"`, []);
}
