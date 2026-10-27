import { describe, expect, it } from "vitest";

import {
  daily,
  event,
  every,
  hourly,
  manual,
  monthly,
  once,
  schedule,
  webhook,
  weekly,
} from "../src/triggers";
import {
  discordAppEventsWebhook,
  discordAppInteractionsWebhook,
  githubWebhook,
  metaAppWhatsAppWebhook,
  shopifyWebhook,
  slackAppEventsWebhook,
  standardWebhook,
  stripeWebhook,
  supabaseDatabaseWebhook,
  telegramBotWebhook,
  vercelWebhook,
  wixAppWebhook,
  wixAutomationsWebhook,
} from "../src/webhooks";

describe("schedule", () => {
  it("builds a schedule trigger without a timezone", () => {
    expect(schedule("0 9 * * *", { key: "morning" })).toEqual({
      type: "schedule",
      key: "morning",
      cron: "0 9 * * *",
    });
  });

  it("omits the tz key when no timezone is provided", () => {
    expect("tz" in schedule("0 9 * * *", { key: "morning" })).toBe(false);
  });

  it("includes the timezone when provided", () => {
    expect(schedule("0 9 * * *", { key: "morning", tz: "Europe/Vilnius" })).toEqual({
      type: "schedule",
      key: "morning",
      cron: "0 9 * * *",
      tz: "Europe/Vilnius",
    });
  });

  it("accepts a cron alias", () => {
    expect(schedule("@daily", { key: "nightly" })).toEqual({
      type: "schedule",
      key: "nightly",
      cron: "@daily",
    });
  });

  it("throws on a 6-field cron", () => {
    expect(() => schedule("* * * * * *", { key: "k" })).toThrow("invalid cron");
  });

  it("throws on a 4-field cron", () => {
    expect(() => schedule("0 9 * *", { key: "k" })).toThrow("invalid cron");
  });
});

describe("manual", () => {
  it("builds a manual trigger carrying its trimmed key", () => {
    expect(manual({ key: "  rerun  " })).toEqual({ type: "manual", key: "rerun" });
  });
});

describe("once", () => {
  it("builds a one-time trigger from an ISO instant", () => {
    expect(once("2026-08-01T09:00:00Z", { key: "launch" })).toEqual({
      type: "once",
      key: "launch",
      at: "2026-08-01T09:00:00Z",
    });
  });

  it("trims the instant", () => {
    expect(once("  2026-08-01T09:00:00Z  ", { key: "launch" })).toEqual({
      type: "once",
      key: "launch",
      at: "2026-08-01T09:00:00Z",
    });
  });

  it("throws on an unparseable instant", () => {
    expect(() => once("not-a-date", { key: "launch" })).toThrow("invalid one-time date");
  });

  it("points a bare time of day at the builder that accepts one", () => {
    expect(() => once("11:57", { key: "launch" })).toThrow(/2026-08-01T09:00:00Z/);
    expect(() => once("11:57", { key: "launch" })).toThrow(/daily\(\{ key: "launch", at: "11:57" \}\)/);
  });
});

describe("coarse schedule builders", () => {
  it("hourly defaults to minute 0", () => {
    expect(hourly({ key: "tick" })).toEqual({ type: "schedule", key: "tick", cron: "0 * * * *" });
  });

  it("hourly accepts a minute", () => {
    expect(hourly({ key: "tick", minute: 30 })).toEqual({
      type: "schedule",
      key: "tick",
      cron: "30 * * * *",
    });
  });

  it("hourly throws on an out-of-range minute", () => {
    expect(() => hourly({ key: "tick", minute: 60 })).toThrow("invalid minute");
  });

  it("daily defaults to midnight", () => {
    expect(daily({ key: "nightly" })).toEqual({ type: "schedule", key: "nightly", cron: "0 0 * * *" });
  });

  it("daily accepts a time of day", () => {
    expect(daily({ key: "morning", at: "09:00" })).toEqual({
      type: "schedule",
      key: "morning",
      cron: "0 9 * * *",
    });
  });

  it("daily carries a timezone when provided", () => {
    expect(daily({ key: "morning", at: "09:00", tz: "Europe/Vilnius" })).toEqual({
      type: "schedule",
      key: "morning",
      cron: "0 9 * * *",
      tz: "Europe/Vilnius",
    });
  });

  it("daily omits tz when not provided", () => {
    expect("tz" in daily({ key: "nightly" })).toBe(false);
  });

  it("daily throws on an invalid time", () => {
    expect(() => daily({ key: "k", at: "24:00" })).toThrow("invalid time");
  });

  it("daily explains why a seconds component is rejected", () => {
    expect(() => daily({ key: "k", at: "12:34:56" })).toThrow(/minute granularity/);
    expect(() => daily({ key: "k", at: "12:34:56" })).toThrow(/"12:34"/);
  });

  it("weekly defaults to Monday midnight", () => {
    expect(weekly({ key: "week" })).toEqual({ type: "schedule", key: "week", cron: "0 0 * * 1" });
  });

  it("weekly maps the weekday and time", () => {
    expect(weekly({ key: "friday", day: "friday", at: "18:30" })).toEqual({
      type: "schedule",
      key: "friday",
      cron: "30 18 * * 5",
    });
  });

  it("monthly defaults to the first at midnight", () => {
    expect(monthly({ key: "month" })).toEqual({ type: "schedule", key: "month", cron: "0 0 1 * *" });
  });

  it("monthly maps day-of-month and time", () => {
    expect(monthly({ key: "mid-month", dayOfMonth: 15, at: "12:00" })).toEqual({
      type: "schedule",
      key: "mid-month",
      cron: "0 12 15 * *",
    });
  });

  it("monthly throws on an out-of-range day", () => {
    expect(() => monthly({ key: "k", dayOfMonth: 32 })).toThrow("invalid dayOfMonth");
  });
});

describe("schedule windows", () => {
  it("daily carries a window in minutes", () => {
    expect(daily({ key: "post", at: "08:00", within: "1h", tz: "Europe/Vilnius" })).toEqual({
      type: "schedule",
      key: "post",
      cron: "0 8 * * *",
      tz: "Europe/Vilnius",
      window: { minutes: 60 },
    });
  });

  it("omits the window when none is given", () => {
    expect("window" in daily({ key: "post", at: "08:00" })).toBe(false);
    expect("window" in once("2026-11-03T08:00:00Z", { key: "launch" })).toBe(false);
  });

  it.each([
    ["hourly", () => hourly({ key: "k", within: "60m" }), 60],
    ["every 15 minutes", () => every("15m", { key: "k", within: "15m" }), 15],
    ["every 2 hours", () => every("2h", { key: "k", within: "2h" }), 120],
    ["daily", () => daily({ key: "k", within: "24h" }), 1440],
    ["weekly", () => weekly({ key: "k", within: "7d" }), 10080],
    ["monthly on the 1st", () => monthly({ key: "k", within: "28d" }), 40320],
    ["monthly on the 31st", () => monthly({ key: "k", dayOfMonth: 31, within: "31d" }), 44640],
    ["weekdays", () => schedule("0 8 * * 1-5", { key: "k", within: "1d" }), 1440],
    ["twice a day", () => schedule("0 8,12 * * *", { key: "k", within: "4h" }), 240],
    ["an alias", () => schedule("@weekly", { key: "k", within: "7d" }), 10080],
    ["a one-time run", () => once("2026-11-03T08:00:00Z", { key: "k", within: "31d" }), 44640],
  ])("accepts a window as long as the gap between runs of %s", (_name, build, minutes) => {
    expect(build().window).toEqual({ minutes });
  });

  it.each([
    ["hourly", () => hourly({ key: "k", within: "61m" }), /at most 1h/],
    ["every 15 minutes", () => every("15m", { key: "k", within: "16m" }), /at most 15m/],
    ["daily", () => daily({ key: "k", within: "25h" }), /at most 1d/],
    ["weekly", () => weekly({ key: "k", within: "8d" }), /at most 7d/],
    ["monthly on the 1st", () => monthly({ key: "k", within: "29d" }), /at most 28d/],
    ["weekdays", () => schedule("0 8 * * 1-5", { key: "k", within: "2d" }), /at most 1d/],
    ["twice a day", () => schedule("0 8,12 * * *", { key: "k", within: "5h" }), /at most 4h/],
    ["every minute of an hour", () => schedule("* 8 * * *", { key: "k", within: "2m" }), /at most 1m/],
  ])("refuses a window longer than the gap between runs of %s", (_name, build, message) => {
    expect(build).toThrow(message);
  });

  it.each(["0 8 L * *", "0 8 * * MON", "0 8 * * 1#2", "0 8 15W * *"])("refuses a window on the cron %s it cannot measure", (cron) => {
    expect(() => schedule(cron, { key: "k", within: "1h" })).toThrow(/numbers, "\*", ranges, steps and lists only/);
  });

  it.each(["0m", "32d", "1.5h", "1w", "60", ""])("refuses the window %j", (within) => {
    expect(() => daily({ key: "post", at: "08:00", within })).toThrow(/from 1 minute to 31 days/);
  });

  it("keeps picked times inside the hours given by during", () => {
    expect(
      weekly({ key: "k", day: "monday", at: "00:00", within: "5d", during: { from: "9:00", to: "17:00" } }).window,
    ).toEqual({ minutes: 7200, during: { from: "09:00", to: "17:00" } });
  });

  it("accepts during hours that cross midnight", () => {
    expect(daily({ key: "k", at: "20:00", within: "12h", during: { from: "22:00", to: "06:00" } }).window?.during).toEqual({
      from: "22:00",
      to: "06:00",
    });
  });

  it("refuses during hours that no time in the window falls inside", () => {
    expect(() => daily({ key: "k", at: "08:00", within: "1h", during: { from: "12:00", to: "17:00" } })).toThrow(
      /no time between 12:00 and 17:00/,
    );
  });

  it("refuses during hours that start and end at the same time", () => {
    expect(() => daily({ key: "k", within: "24h", during: { from: "09:00", to: "09:00" } })).toThrow(/same time/);
  });

  it("carries the number of runs per window", () => {
    expect(daily({ key: "k", at: "09:00", within: "8h", times: 3 }).window).toEqual({ minutes: 480, times: 3 });
    expect(daily({ key: "k", at: "09:00", within: "8h", times: 1 }).window).toEqual({ minutes: 480 });
  });

  it.each([0, 25, 1.5])("refuses %j runs per window", (times) => {
    expect(() => daily({ key: "k", within: "8h", times })).toThrow(/from 1 to 24/);
  });

  it("refuses more runs than a window has minutes", () => {
    expect(() => hourly({ key: "k", within: "5m", times: 6 })).toThrow(/at most 5 runs/);
  });

  it("refuses during or times without a window", () => {
    expect(() => daily({ key: "k", times: 2 })).toThrow(/need "within"/);
    expect(() => daily({ key: "k", during: { from: "09:00", to: "17:00" } })).toThrow(/need "within"/);
  });
});

describe("every", () => {
  it("builds a minute interval", () => {
    expect(every("15m", { key: "poll" })).toEqual({ type: "schedule", key: "poll", cron: "*/15 * * * *" });
  });

  it("builds an hour interval", () => {
    expect(every("2h", { key: "poll" })).toEqual({ type: "schedule", key: "poll", cron: "0 */2 * * *" });
  });

  it("carries a timezone when provided", () => {
    expect(every("30m", { key: "poll", tz: "Europe/Vilnius" })).toEqual({
      type: "schedule",
      key: "poll",
      cron: "*/30 * * * *",
      tz: "Europe/Vilnius",
    });
  });

  it("throws on a non-dividing minute interval", () => {
    expect(() => every("7m", { key: "k" })).toThrow("invalid interval");
  });

  it("throws on a cross-field minute interval", () => {
    expect(() => every("90m", { key: "k" })).toThrow("invalid interval");
  });

  it("throws on a non-dividing hour interval", () => {
    expect(() => every("5h", { key: "k" })).toThrow("invalid interval");
  });

  it("throws on a malformed interval", () => {
    expect(() => every("abc", { key: "k" })).toThrow("invalid interval");
  });
});

const KEYED_BUILDERS = [
  ["manual", (key: string) => manual({ key })],
  ["schedule", (key: string) => schedule("0 9 * * *", { key })],
  ["hourly", (key: string) => hourly({ key })],
  ["daily", (key: string) => daily({ key })],
  ["weekly", (key: string) => weekly({ key })],
  ["monthly", (key: string) => monthly({ key })],
  ["every", (key: string) => every("15m", { key })],
  ["once", (key: string) => once("2026-08-01T09:00:00Z", { key })],
] as const;

describe.each(KEYED_BUILDERS)("%s key", (name, build) => {
  it("trims the stable key", () => {
    expect(build("  stable  ").key).toBe("stable");
  });

  it("requires a non-empty stable key", () => {
    expect(() => build("   ")).toThrow(`invalid ${name} key: expected a non-empty stable key`);
  });

  it("refuses a missing key rather than inventing one", () => {
    expect(() => build(undefined as unknown as string)).toThrow(`invalid ${name} key`);
  });
});

const HELPERS = [
  { helper: "metaAppWhatsAppWebhook", build: metaAppWhatsAppWebhook, provider: "meta" },
  { helper: "slackAppEventsWebhook", build: slackAppEventsWebhook, provider: "slack" },
  { helper: "stripeWebhook", build: stripeWebhook, provider: "stripe" },
  { helper: "githubWebhook", build: githubWebhook, provider: "github" },
  { helper: "shopifyWebhook", build: shopifyWebhook, provider: "shopify" },
  { helper: "standardWebhook", build: standardWebhook, provider: "standard-webhooks" },
  { helper: "telegramBotWebhook", build: telegramBotWebhook, provider: "telegram" },
  { helper: "supabaseDatabaseWebhook", build: supabaseDatabaseWebhook, provider: "supabase" },
  { helper: "vercelWebhook", build: vercelWebhook, provider: "vercel" },
  { helper: "discordAppInteractionsWebhook", build: discordAppInteractionsWebhook, provider: "discord" },
  { helper: "discordAppEventsWebhook", build: discordAppEventsWebhook, provider: "discord-events" },
  { helper: "wixAppWebhook", build: wixAppWebhook, provider: "wix-app" },
] as const;

describe.each(HELPERS)("$helper", ({ build, provider }) => {
  it("declares a signed endpoint its provider verifies", () => {
    expect(build({ key: "  k  ", name: "Inbound" })).toEqual({
      type: "webhook",
      key: "k",
      name: "Inbound",
      auth: "signature",
      provider,
    });
  });

  it("requires a non-empty stable key", () => {
    expect(() => build({ key: "  " })).toThrow(/non-empty stable key/);
  });
});

describe("wixAutomationsWebhook", () => {
  it("names the Wix Automations sender without claiming a signature it cannot carry", () => {
    expect(wixAutomationsWebhook({ key: "  form-submitted  ", name: "Form submitted" })).toEqual({
      type: "webhook",
      key: "form-submitted",
      name: "Form submitted",
      provider: "wix-automations",
    });
  });

  it("requires a non-empty stable key", () => {
    expect(() => wixAutomationsWebhook({ key: "  " })).toThrow(/non-empty stable key/);
  });
});

describe("slackAppEventsWebhook", () => {
  it("has no event selector: every subscribed Slack event reaches the run", () => {
    expect("event" in slackAppEventsWebhook({ key: "events" })).toBe(false);
  });
});

describe("webhook", () => {
  it("builds an unverified webhook trigger carrying only its identity", () => {
    expect(webhook({ key: "  inbound  ", name: "Inbound" })).toEqual({
      type: "webhook",
      key: "inbound",
      name: "Inbound",
    });
  });

  it("requires a non-empty stable key", () => {
    expect(() => webhook({ key: "" })).toThrow(/non-empty stable key/i);
    expect(() => webhook({ key: "   ", name: "Display only" })).toThrow(/non-empty stable key/i);
  });

  it.each([
    ["auth", { key: "k", auth: "signature" }],
    ["provider", { key: "k", provider: "stripe" }],
    ["event", { key: "k", event: "app_mention" }],
  ])("refuses %s, pointing a signing sender at its helper", (_option, options) => {
    expect(() => webhook(options as unknown as Parameters<typeof webhook>[0])).toThrow(
      /@wix\/whenever-workflow-sdk\/webhooks/,
    );
  });
});

describe("event", () => {
  it("builds a managed event descriptor", () => {
    expect(
      event({
        key: "new-mail",
        source: "gmail.new-gmail-message",
        config: { labels: ["INBOX"] },
      }),
    ).toEqual({
      type: "event",
      key: "new-mail",
      source: "gmail.new-gmail-message",
      config: { labels: ["INBOX"] },
    });
  });

  it("trims the stable key and source and defaults config", () => {
    expect(event({ key: "  order  ", source: "  order.created  " })).toEqual({
      type: "event",
      key: "order",
      source: "order.created",
      config: {},
    });
  });

  it("throws on an empty key or source", () => {
    expect(() => event({ key: "   ", source: "order.created" })).toThrow(
      "invalid event key",
    );
    expect(() => event({ key: "order", source: "   " })).toThrow(
      "invalid event source",
    );
  });

  it("rejects a descriptor that is not an object", () => {
    expect(() =>
      event("order.created" as unknown as Parameters<typeof event>[0]),
    ).toThrow("invalid event descriptor");
  });

  it("rejects a non-object config", () => {
    expect(() =>
      event({
        key: "order",
        source: "order.created",
        config: [] as unknown as Record<string, unknown>,
      }),
    ).toThrow("invalid event config");
  });
});
