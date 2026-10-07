import type {
  EventTrigger,
  ManualTrigger,
  OnceTrigger,
  ScheduleTrigger,
  WebhookTrigger,
} from "./types";

export interface TriggerIdentity {
  /** Stable name of this trigger, unique across the workflow's triggers; runs carry it as `ctx.trigger.key`. */
  key: string;
}

export interface ScheduleOptions extends TriggerIdentity {
  tz?: string;
}

export type ManualOptions = TriggerIdentity;

export type OnceOptions = TriggerIdentity;

export interface EventOptions {
  key: string;
  source: string;
  config?: Readonly<Record<string, unknown>>;
}

export type Weekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export interface HourlyOptions extends TriggerIdentity {
  /** Minute past the hour, an integer 0-59. Defaults to 0. */
  minute?: number;
  /** IANA timezone the schedule is interpreted in, such as "Europe/Vilnius". */
  tz?: string;
}

export interface DailyOptions extends TriggerIdentity {
  /**
   * Time of day as "HH:MM" on a 24-hour clock, such as "09:00" or "18:30".
   * Defaults to midnight.
   *
   * These builders lower to a five-field cron, which is minute-granular, so
   * seconds are not accepted: pass "12:34", not "12:34:56".
   */
  at?: string;
  /** IANA timezone the schedule is interpreted in, such as "Europe/Vilnius". */
  tz?: string;
}

export interface WeeklyOptions extends TriggerIdentity {
  /** Weekday name, lowercase. Defaults to "monday". */
  day?: Weekday;
  /**
   * Time of day as `"HH:MM"` on a 24-hour clock. Minute-granular, so
   * seconds are not accepted. Defaults to midnight.
   */
  at?: string;
  /** IANA timezone the schedule is interpreted in, such as "Europe/Vilnius". */
  tz?: string;
}

export interface MonthlyOptions extends TriggerIdentity {
  /** Day of the month, an integer 1-31. Defaults to 1. */
  dayOfMonth?: number;
  /**
   * Time of day as `"HH:MM"` on a 24-hour clock. Minute-granular, so
   * seconds are not accepted. Defaults to midnight.
   */
  at?: string;
  /** IANA timezone the schedule is interpreted in, such as "Europe/Vilnius". */
  tz?: string;
}

const CRON_ALIASES = new Set(["@hourly", "@daily", "@weekly", "@monthly"]);

const WEEKDAYS: Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

/**
 * Declares a recurring trigger from a cron expression.
 *
 * Takes either five whitespace-separated fields
 * (`minute hour day-of-month month day-of-week`) or one of the `@hourly`,
 * `@daily`, `@weekly`, `@monthly` aliases. Six-field (seconds-granular) cron
 * is not accepted — the smallest expressible interval is one minute.
 *
 * Only the field count is checked here; field ranges and `tz` identifiers are
 * not validated. Prefer `hourly`, `daily`, `weekly`, `monthly`, or `every`
 * when one of them expresses the intent.
 */
export function schedule(cron: string, options: ScheduleOptions): ScheduleTrigger {
  const key = stableKey("schedule", options);
  const normalized = cron.trim();
  const fieldCount =
    normalized.length === 0 ? 0 : normalized.split(/\s+/).length;
  if (!CRON_ALIASES.has(normalized) && fieldCount !== 5) {
    throw new Error(
      `invalid cron "${cron}": expected 5 fields (minute hour day-of-month month day-of-week) or one of @hourly/@daily/@weekly/@monthly`,
    );
  }
  return options.tz === undefined
    ? { type: "schedule", key, cron: normalized }
    : { type: "schedule", key, cron: normalized, tz: options.tz };
}

/** Declares a trigger that never fires automatically: a person runs it on demand. */
export function manual(options: ManualOptions): ManualTrigger {
  return { type: "manual", key: stableKey("manual", options) };
}

/**
 * Declares a trigger that fires exactly once, at an absolute point in time.
 *
 * `at` is an absolute ISO 8601 instant naming a specific calendar date — for
 * example "2026-08-01T09:00:00Z". It is not a time of day: a bare "11:57"
 * names no date and is rejected. To run at a time of day, use a recurring
 * builder such as daily({ key: "lunch", at: "11:57" }).
 *
 * Only parseability is validated here; the SDK does not check that the
 * instant is in the future.
 */
export function once(at: string, options: OnceOptions): OnceTrigger {
  const key = stableKey("once", options);
  const normalized = at.trim();
  if (Number.isNaN(Date.parse(normalized))) {
    const timeOfDay = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(normalized);
    const hint =
      timeOfDay === null
        ? ""
        : ` — "${normalized}" is a time of day, not a date; for a recurring run at that time use daily({ key: "${key}", at: "${timeOfDay[1].padStart(2, "0")}:${timeOfDay[2]}" })`;
    throw new Error(
      `invalid one-time date "${at}": expected an absolute ISO 8601 instant like "2026-08-01T09:00:00Z"${hint}`,
    );
  }
  return { type: "once", key, at: normalized };
}

/** Declares a trigger that fires once an hour, at `minute` past the hour. */
export function hourly(options: HourlyOptions): ScheduleTrigger {
  const key = stableKey("hourly", options);
  const minute = options.minute ?? 0;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(
      `invalid minute "${String(options.minute)}": expected an integer 0-59`,
    );
  }
  return schedule(`${String(minute)} * * * *`, { key, tz: options.tz });
}

/**
 * Declares a trigger that fires once a day at `at`, a `"HH:MM"` 24-hour time
 * (minute-granular — seconds are not accepted). Defaults to midnight.
 */
export function daily(options: DailyOptions): ScheduleTrigger {
  const key = stableKey("daily", options);
  const { hour, minute } = parseTimeOfDay(options.at ?? "00:00");
  return schedule(`${String(minute)} ${String(hour)} * * *`, {
    key,
    tz: options.tz,
  });
}

/**
 * Declares a trigger that fires once a week on `day` at `at`, a `"HH:MM"`
 * 24-hour time (minute-granular). Defaults to Monday at midnight.
 */
export function weekly(options: WeeklyOptions): ScheduleTrigger {
  const key = stableKey("weekly", options);
  const { hour, minute } = parseTimeOfDay(options.at ?? "00:00");
  const day = options.day ?? "monday";
  const dayOfWeek = WEEKDAYS.indexOf(day);
  if (dayOfWeek < 0) {
    throw new Error(`invalid weekday "${String(day)}"`);
  }
  return schedule(
    `${String(minute)} ${String(hour)} * * ${String(dayOfWeek)}`,
    { key, tz: options.tz },
  );
}

/**
 * Declares a trigger that fires once a month on `dayOfMonth` at `at`, a
 * `"HH:MM"` 24-hour time (minute-granular). Defaults to the 1st at midnight.
 *
 * A `dayOfMonth` past the end of a short month does not fire that month.
 */
export function monthly(options: MonthlyOptions): ScheduleTrigger {
  const key = stableKey("monthly", options);
  const { hour, minute } = parseTimeOfDay(options.at ?? "00:00");
  const dayOfMonth = options.dayOfMonth ?? 1;
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    throw new Error(
      `invalid dayOfMonth "${String(options.dayOfMonth)}": expected an integer 1-31`,
    );
  }
  return schedule(
    `${String(minute)} ${String(hour)} ${String(dayOfMonth)} * *`,
    { key, tz: options.tz },
  );
}

/**
 * Declares a trigger that fires on a fixed interval, written as `"<n>m"` or
 * `"<n>h"` — for example `"15m"` or `"2h"`.
 *
 * The interval must divide its field evenly (60 for minutes, 24 for hours),
 * so that firings stay aligned across every hour or day. `"7m"` and `"90m"`
 * are rejected; use `schedule` for a pattern that does not fit.
 */
export function every(interval: string, options: ScheduleOptions): ScheduleTrigger {
  const key = stableKey("every", options);
  const match = /^(\d+)(m|h)$/.exec(interval.trim());
  if (match === null) {
    throw new Error(
      `invalid interval "${interval}": expected "<n>m" or "<n>h"`,
    );
  }
  const value = Number(match[1]);
  if (match[2] === "m") {
    if (value < 1 || value >= 60 || 60 % value !== 0) {
      throw new Error(
        `invalid interval "${interval}": minutes must evenly divide 60`,
      );
    }
    return schedule(`*/${String(value)} * * * *`, { key, tz: options.tz });
  }
  if (value < 1 || value >= 24 || 24 % value !== 0) {
    throw new Error(
      `invalid interval "${interval}": hours must evenly divide 24`,
    );
  }
  return schedule(`0 */${String(value)} * * *`, { key, tz: options.tz });
}

export interface WebhookOptions {
  key: string;
  name?: string;
}

/**
 * Declares an unverified inbound HTTP webhook: any request to its URL starts a run.
 *
 * `key` is the stable identity the host binds an endpoint URL to; changing
 * it issues a different URL, so keep it fixed across edits. `name` is optional
 * display text and is never used as endpoint identity.
 *
 * The endpoint checks no signature or token. For a sender that signs its
 * deliveries, declare its helper from `@wix/whenever-workflow-sdk/webhooks`
 * instead (`metaAppWhatsAppWebhook`, `slackAppEventsWebhook`, `stripeWebhook`,
 * `githubWebhook`, `shopifyWebhook`, `standardWebhook`, `telegramBotWebhook`,
 * `wixAppWebhook`); the host must verify those with the sender's credentials. For a Wix Automations automation declare `wixAutomationsWebhook`: as
 * unverified as this one, but it names the sender whose body the run receives.
 *
 * Throws when `key` is empty, or when given a signing option such as `provider`
 * that only a sender's helper declares.
 */
export function webhook(opts: WebhookOptions): WebhookTrigger {
  const key = opts.key.trim();
  if (key === "") {
    throw new Error("invalid webhook key: expected a non-empty stable key");
  }
  const signing = ["auth", "provider", "event"].filter((option) => option in opts);
  if (signing.length > 0) {
    throw new Error(
      `webhook() takes no ${signing.join(", ")}: it is unverified; declare a signing sender with its helper from "@wix/whenever-workflow-sdk/webhooks"`,
    );
  }
  const trigger: WebhookTrigger = { type: "webhook", key };
  if (opts.name !== undefined) trigger.name = opts.name;
  return trigger;
}

/**
 * Declares a managed provider event with a stable workflow-local `key`.
 *
 * The host defines supported `source` values and their `config` fields and validates them before
 * activation. This SDK function validates only the portable descriptor shape.
 */
export function event(options: EventOptions): EventTrigger {
  if (options === null || typeof options !== "object") {
    throw new Error(
      "invalid event descriptor: expected event({ key, source, config })",
    );
  }
  const key = options.key.trim();
  const source = options.source.trim();
  if (key.length === 0) {
    throw new Error("invalid event key: expected a non-empty stable key");
  }
  if (source.length === 0) {
    throw new Error("invalid event source: expected a non-empty string");
  }
  if (
    options.config !== undefined &&
    (options.config === null ||
      Array.isArray(options.config) ||
      typeof options.config !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options.config)))
  ) {
    throw new Error("invalid event config: expected an object");
  }
  return {
    type: "event",
    key,
    source,
    config: options.config ?? {},
  };
}

function stableKey(builder: string, options: TriggerIdentity | undefined): string {
  const key = typeof options?.key === "string" ? options.key.trim() : "";
  if (key === "") {
    throw new Error(`invalid ${builder} key: expected a non-empty stable key`);
  }
  return key;
}

function parseTimeOfDay(at: string): { hour: number; minute: number } {
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
