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
  telegramBotWebhook,
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
  it("narrows the endpoint to the trimmed Slack event it names", () => {
    expect(slackAppEventsWebhook({ key: "mentions", event: "  app_mention  " }).event).toBe("app_mention");
  });

  it("omits the event when none is selected", () => {
    expect("event" in slackAppEventsWebhook({ key: "events" })).toBe(false);
  });

  it("refuses a blank event", () => {
    expect(() => slackAppEventsWebhook({ key: "events", event: "   " })).toThrow(/non-empty event name/);
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
