import { expectTypeOf, test } from "vitest";

import type { WorkflowStep, WorkflowStepExecutor } from "../src/define-step";
import type {
  AiConversationResult,
  AiConversationTextResult,
  AiGenerateImageInput,
  AiGenerateImageResult,
  AiGenerateTextInput,
  AiGenerateTextResult,
  AiMessage,
  CreateWorkflowContextOptions,
  HttpResponseResult,
  HttpWriteResult,
  PostgresQueryResult,
  WebhookAuth,
  WebhookProvider,
} from "../src/index";
import { defineStep, defineWorkflow } from "../src/index";
import type { Weekday } from "../src/triggers";
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
import type {
  EventTrigger,
  LogFn,
  OnceTrigger,
  ScheduleTrigger,
  Trigger,
  WebhookTrigger,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowManifest,
  WorkflowTriggerContext,
} from "../src/types";
import {
  githubWebhook,
  metaAppWhatsAppWebhook,
  slackAppEventsWebhook,
  stripeWebhook,
  telegramBotWebhook,
} from "../src/webhooks";

test("defineWorkflow returns a WorkflowDefinition", () => {
  expectTypeOf(defineWorkflow(async () => {})).toEqualTypeOf<
    WorkflowDefinition<void, void>
  >();
});

test("defineWorkflow infers the run output type", () => {
  expectTypeOf(defineWorkflow(async () => 5)).toEqualTypeOf<
    WorkflowDefinition<void, number>
  >();
});

test("context input carries the declared input type", () => {
  expectTypeOf<WorkflowContext<{ id: string }>["input"]>().toEqualTypeOf<{
    id: string;
  }>();
});

test("context clock helpers return numbers", () => {
  expectTypeOf<WorkflowContext["now"]>().returns.toEqualTypeOf<number>();
  expectTypeOf<WorkflowContext["random"]>().returns.toEqualTypeOf<number>();
});

test("config and secrets are string records indexed by name", () => {
  const ctx = {} as WorkflowContext;

  expectTypeOf(ctx.config).toEqualTypeOf<Readonly<Record<string, string>>>();
  expectTypeOf(ctx.secrets).toEqualTypeOf<Readonly<Record<string, string>>>();
  expectTypeOf(ctx.config.SLACK_CHANNEL_ID).toEqualTypeOf<string>();
  expectTypeOf(ctx.secrets.WEBHOOK_SIGNING_SECRET).toEqualTypeOf<string>();
});

test("defineStep infers input, arguments, and the resolved result", () => {
  const step = defineStep(
    "add",
    (ctx: WorkflowContext<{ offset: number }>, value: number) =>
      ctx.input.offset + value,
  );

  expectTypeOf(step).toEqualTypeOf<
    WorkflowStep<{ offset: number }, [value: number], number>
  >();
  expectTypeOf(step({} as WorkflowContext<{ offset: number }>, 2)).toEqualTypeOf<
    Promise<number>
  >();
});

test("workflow step identity is not part of the public string-keyed shape", () => {
  expectTypeOf<Extract<keyof WorkflowStep, "brand">>().toEqualTypeOf<never>();
  expectTypeOf<WorkflowStep["stepName"]>().toEqualTypeOf<string>();
});

test("runtime context construction accepts a step executor", () => {
  expectTypeOf<CreateWorkflowContextOptions<void>["step"]>().toEqualTypeOf<
    WorkflowStepExecutor
  >();
});

test("context exposes a log annotation sink returning void", () => {
  const ctx = {} as WorkflowContext;

  expectTypeOf(ctx.log).toEqualTypeOf<LogFn>();
  expectTypeOf(ctx.log("analyzing emails")).toEqualTypeOf<void>();
  expectTypeOf(ctx.log("analyzing emails", { count: 3 })).toEqualTypeOf<void>();
});

test("workflow context exposes a typed outbound HTTP integration", () => {
  const ctx = {} as WorkflowContext;

  expectTypeOf(
    ctx.integrations.http.get({ url: "https://example.com" }),
  ).toEqualTypeOf<Promise<HttpResponseResult>>();
  expectTypeOf(
    ctx.integrations.http.post({
      url: "https://example.com",
      body: { hello: "world" },
    }),
  ).toEqualTypeOf<Promise<HttpWriteResult>>();
  expectTypeOf(
    ctx.integrations.http.put({
      url: "https://example.com",
      body: { hello: "world" },
    }),
  ).toEqualTypeOf<Promise<HttpWriteResult>>();
});

test("workflow context exposes a typed AI text generation integration", () => {
  const ctx = {} as WorkflowContext;

  expectTypeOf(
    ctx.integrations.ai.generateText({ prompt: "Summarize this." }),
  ).toEqualTypeOf<Promise<AiGenerateTextResult>>();
  expectTypeOf(
    ctx.integrations.ai.generateText({
      system: "Answer in French.",
      prompt: "Summarize this.",
    }),
  ).toEqualTypeOf<Promise<AiGenerateTextResult>>();
  expectTypeOf<{ prompt: "x" }>().toExtend<AiGenerateTextInput>();
});

const JIRA_TOOLS = {
  getIssue: {
    description: "Read one Jira issue.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  editIssue: {
    description: "Change one Jira issue's summary.",
    parameters: { type: "object", properties: {} },
  },
} as const;

test("a conversation without tools can only stop with text", () => {
  const ctx = {} as WorkflowContext;

  expectTypeOf(
    ctx.integrations.ai.generateText({
      messages: [{ role: "user", content: "Hello." }],
    }),
  ).toEqualTypeOf<Promise<AiConversationTextResult>>();
});

test("a conversation with tools names its tool calls by the tool keys", async () => {
  const ctx = {} as WorkflowContext;
  const messages: AiMessage[] = [{ role: "user", content: "Close ABC-1." }];

  const turn = await ctx.integrations.ai.generateText({
    system: "You administer Jira.",
    messages,
    tools: JIRA_TOOLS,
    toolChoice: { name: "getIssue" },
  });
  messages.push(turn.message);

  if (turn.finishReason === "tool-calls") {
    expectTypeOf(turn.toolCalls[0].name).toEqualTypeOf<"getIssue" | "editIssue">();
    expectTypeOf(turn.toolCalls[0].arguments).toEqualTypeOf<unknown>();
    expectTypeOf(turn).not.toHaveProperty("text");
    messages.push({
      role: "tool",
      toolCallId: turn.toolCalls[0].id,
      content: "{}",
    });
  } else {
    expectTypeOf(turn.text).toEqualTypeOf<string>();
    expectTypeOf(turn).not.toHaveProperty("toolCalls");
  }
  expectTypeOf(turn).toEqualTypeOf<
    AiConversationResult<"getIssue" | "editIssue">
  >();
});

test("the prompt and conversation shapes cannot be mixed", () => {
  const ai = {} as WorkflowContext["integrations"]["ai"];
  const messages: AiMessage[] = [{ role: "user", content: "Hi." }];

  // @ts-expect-error a prompt call cannot also carry a history
  void ai.generateText({ prompt: "Hi.", messages });
  // @ts-expect-error tools need a conversation
  void ai.generateText({ prompt: "Hi.", tools: JIRA_TOOLS });
  // @ts-expect-error a call needs either a prompt or a history
  void ai.generateText({ system: "Be brief." });
  // @ts-expect-error toolChoice needs tools
  void ai.generateText({ messages, toolChoice: "required" });
  // @ts-expect-error toolChoice can only name a declared tool
  void ai.generateText({ messages, tools: JIRA_TOOLS, toolChoice: { name: "deleteIssue" } });
  // @ts-expect-error a tool's parameters are a JSON Schema object
  void ai.generateText({ messages, tools: { a: { description: "A.", parameters: { type: "string" } } } });
});

test("workflow context exposes a typed AI image generation integration", () => {
  const ctx = {} as WorkflowContext;

  expectTypeOf(
    ctx.integrations.ai.generateImage({ prompt: "Illustrate this workflow." }),
  ).toEqualTypeOf<Promise<AiGenerateImageResult>>();
  expectTypeOf(ctx.integrations.ai.generateImage)
    .parameter(0)
    .toEqualTypeOf<AiGenerateImageInput>();
});

test("workflow context exposes a typed database query integration", () => {
  const ctx = {} as WorkflowContext;

  expectTypeOf(
    ctx.integrations.postgres.query({ sql: "select 1 as n" }),
  ).toEqualTypeOf<Promise<PostgresQueryResult>>();
});

test("Trigger union membership", () => {
  expectTypeOf<Trigger["type"]>().toEqualTypeOf<
    "schedule" | "manual" | "once" | "webhook" | "event"
  >();
});

test("coarse and interval builders return ScheduleTrigger", () => {
  expectTypeOf(hourly({ key: "tick" })).toEqualTypeOf<ScheduleTrigger>();
  expectTypeOf(daily({ key: "morning" })).toEqualTypeOf<ScheduleTrigger>();
  expectTypeOf(weekly({ key: "week" })).toEqualTypeOf<ScheduleTrigger>();
  expectTypeOf(monthly({ key: "month" })).toEqualTypeOf<ScheduleTrigger>();
  expectTypeOf(every("15m", { key: "poll" })).toEqualTypeOf<ScheduleTrigger>();
});

test("once returns an OnceTrigger", () => {
  expectTypeOf(once("2026-08-01T09:00:00Z", { key: "launch" })).toEqualTypeOf<OnceTrigger>();
});

test("every trigger builder requires an explicit stable key", () => {
  // @ts-expect-error manual requires a key
  manual();
  // @ts-expect-error schedule requires a key
  schedule("0 9 * * *");
  // @ts-expect-error schedule options must carry the key
  schedule("0 9 * * *", { tz: "Europe/Vilnius" });
  // @ts-expect-error hourly requires a key
  hourly();
  // @ts-expect-error daily options must carry the key
  daily({ at: "09:00" });
  // @ts-expect-error weekly requires a key
  weekly();
  // @ts-expect-error monthly requires a key
  monthly();
  // @ts-expect-error every requires a key
  every("15m");
  // @ts-expect-error once requires a key
  once("2026-08-01T09:00:00Z");
});

test("every trigger shape carries its key", () => {
  expectTypeOf<Trigger["key"]>().toEqualTypeOf<string>();
});

test("every run carries the declared trigger that caused it", () => {
  expectTypeOf<WorkflowContext["trigger"]>().toEqualTypeOf<WorkflowTriggerContext>();
  expectTypeOf<WorkflowTriggerContext["type"]>().toEqualTypeOf<Trigger["type"]>();
  expectTypeOf<WorkflowTriggerContext["key"]>().toEqualTypeOf<string>();
});

test("ctx.trigger narrows to the fields its trigger type delivers", () => {
  const trigger = {} as WorkflowTriggerContext;
  if (trigger.type === "schedule") {
    expectTypeOf(trigger.cron).toEqualTypeOf<string>();
    expectTypeOf(trigger.expectedAt).toEqualTypeOf<number>();
  }
  if (trigger.type === "once") expectTypeOf(trigger.expectedAt).toEqualTypeOf<number>();
  if (trigger.type === "webhook") expectTypeOf(trigger.deliveryId).toEqualTypeOf<string>();
  if (trigger.type === "event") {
    expectTypeOf(trigger.source).toEqualTypeOf<string>();
    expectTypeOf(trigger.deliveryId).toEqualTypeOf<string>();
  }
  if (trigger.type === "manual") expectTypeOf(trigger.deliveryId).toEqualTypeOf<undefined>();
});

test("an unnarrowed delivery field reads as absent rather than failing to compile", () => {
  const trigger = {} as WorkflowTriggerContext;
  expectTypeOf(trigger.eventType).toEqualTypeOf<string | undefined>();
  expectTypeOf(trigger.source).toEqualTypeOf<string | undefined>();
  expectTypeOf(trigger.deliveryId).toEqualTypeOf<string | undefined>();
});

test("a provider helper takes only the endpoint's identity, never a secret", () => {
  expectTypeOf(metaAppWhatsAppWebhook({ key: "wa" })).toEqualTypeOf<WebhookTrigger>();
  expectTypeOf(slackAppEventsWebhook({ key: "mentions", event: "app_mention" })).toEqualTypeOf<WebhookTrigger>();
  // @ts-expect-error the host supplies signing credentials, not the declaration
  stripeWebhook({ key: "s", signingSecret: "whsec_x" });
  // @ts-expect-error a helper fixes its provider, so another cannot be passed
  githubWebhook({ key: "g", provider: "stripe" });
  // @ts-expect-error every helper requires an explicit stable key
  telegramBotWebhook({});
});

test("webhook takes only a key and a display name", () => {
  expectTypeOf(webhook({ key: "inbound", name: "Inbound" })).toEqualTypeOf<WebhookTrigger>();
  // @ts-expect-error a signing sender is declared with its helper
  webhook({ key: "orders", auth: "signature", provider: "stripe" });
  // @ts-expect-error an unverified endpoint has no provider to interpret an event
  webhook({ key: "inbound", event: "app_mention" });
  // @ts-expect-error every webhook requires an explicit stable key
  webhook();
  // @ts-expect-error name is display text, not endpoint identity
  webhook({ name: "Orders" });
});

test("WebhookTrigger auth is a WebhookAuth or undefined", () => {
  expectTypeOf<WebhookTrigger["auth"]>().toEqualTypeOf<
    WebhookAuth | undefined
  >();
});

test("WebhookTrigger provider is a WebhookProvider or undefined", () => {
  expectTypeOf<WebhookTrigger["provider"]>().toEqualTypeOf<
    WebhookProvider | undefined
  >();
});

test("WebhookTrigger key is required", () => {
  expectTypeOf<WebhookTrigger["key"]>().toEqualTypeOf<string>();
});

test("WebhookTrigger event is an optional sender event name", () => {
  expectTypeOf<WebhookTrigger["event"]>().toEqualTypeOf<string | undefined>();
});

test("WebhookAuth enumerates the webhook auth modes", () => {
  expectTypeOf<WebhookAuth>().toEqualTypeOf<"signature" | "none">();
});

test("WebhookProvider enumerates the supported providers", () => {
  expectTypeOf<WebhookProvider>().toEqualTypeOf<
    | "discord"
    | "discord-events"
    | "stripe"
    | "github"
    | "meta"
    | "shopify"
    | "slack"
    | "standard-webhooks"
    | "telegram"
    | "wix-app"
    | "wix-automations"
  >();
});

test("event returns an EventTrigger", () => {
  expectTypeOf(
    event({ key: "order", source: "order.created", config: { region: "eu" } }),
  ).toEqualTypeOf<EventTrigger>();
  // @ts-expect-error event requires an object descriptor
  event("order.created");
});

test("Weekday enumerates the days of the week", () => {
  expectTypeOf<Weekday>().toEqualTypeOf<
    | "sunday"
    | "monday"
    | "tuesday"
    | "wednesday"
    | "thursday"
    | "friday"
    | "saturday"
  >();
});

test("WorkflowManifest declares a name and a list of triggers", () => {
  const m: WorkflowManifest = {
    name: "x",
    triggers: [
      schedule("0 9 * * *", { key: "cron" }),
      manual({ key: "rerun" }),
      once("2026-08-01T09:00:00Z", { key: "launch" }),
      daily({ key: "morning", at: "09:00" }),
      every("15m", { key: "poll" }),
      webhook({ key: "inbound" }),
      event({ key: "order", source: "order.created" }),
    ],
  };

  expectTypeOf(m).toEqualTypeOf<WorkflowManifest>();
  expectTypeOf<WorkflowManifest["triggers"]>().toEqualTypeOf<[Trigger, ...Trigger[]]>();
});

test("WorkflowManifest refuses an empty trigger list", () => {
  // @ts-expect-error a workflow nothing can start is not a workflow
  const m: WorkflowManifest = { name: "x", triggers: [] };

  expectTypeOf(m.triggers[0]).toEqualTypeOf<Trigger>();
});
