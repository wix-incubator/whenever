import type { WorkflowIntegrations } from "./integrations";

export interface WorkflowManifest {
  name: string;
  /** At least one trigger, each with a key unique in this list; add `manual({ key })` to run on demand. */
  triggers: [Trigger, ...Trigger[]];
}

export interface WorkflowDefinition<TInput = void, TOutput = void> {
  readonly brand: string;
  readonly run: WorkflowRun<TInput, TOutput>;
}

export type WorkflowRun<TInput = void, TOutput = void> = (
  ctx: WorkflowContext<TInput>,
) => Promise<TOutput>;

/** What a run's trigger can carry; each `ctx.trigger` type delivers some of these. */
export interface TriggerFields {
  /** The verifier that accepted the delivery, e.g. "stripe" or "generic". */
  integration: string;
  /** The identity the delivery was deduplicated on; safe as an idempotency key downstream. */
  deliveryId: string;
  /** The sender's own name for this event, when the delivery carries one. */
  eventType: string;
  /** The event source declared by `event()`, interpreted by the host. */
  source: string;
  acquisitionKind: "realtime" | "polling";
  /** The verified provider signature timestamp, distinct from the body timestamp. */
  signedAt: string;
  cron: string;
  timeZone: string;
  /** When a scheduled firing was due, in epoch milliseconds. */
  expectedAt: number;
}

/** A trigger type's fields: `R` always present, `O` when known, every other field `undefined`. */
export type Delivers<R extends keyof TriggerFields, O extends keyof TriggerFields = never> = {
  [F in R]: TriggerFields[F];
} & { [F in O]?: TriggerFields[F] } & { [F in Exclude<keyof TriggerFields, R | O>]?: never };

export type ManualTriggerContext = { type: "manual"; key: string } & Delivers<never>;
export type ScheduleTriggerContext = { type: "schedule"; key: string } & Delivers<"cron" | "expectedAt", "timeZone">;
export type OnceTriggerContext = { type: "once"; key: string } & Delivers<"expectedAt">;
export type WebhookTriggerContext = { type: "webhook"; key: string } & Delivers<
  "integration" | "deliveryId",
  "eventType" | "signedAt"
>;
export type EventTriggerContext = { type: "event"; key: string } & Delivers<
  "integration" | "deliveryId" | "source",
  "acquisitionKind" | "eventType" | "signedAt"
>;

/**
 * The declared trigger that started this run, by `type`; `ctx.trigger.key` is its declared key. A
 * manual run carries the trigger the person chose. Never carries headers, account IDs or raw bytes.
 */
export type WorkflowTriggerContext =
  | ManualTriggerContext
  | ScheduleTriggerContext
  | OnceTriggerContext
  | WebhookTriggerContext
  | EventTriggerContext;

export interface WorkflowContext<TInput = void> {
  input: TInput;
  /**
   * Workflow-scoped non-sensitive values explicitly referenced by source as `ctx.config.NAME`.
   * Names are fixed at build time and values are supplied by the workflow owner.
   */
  readonly config: Readonly<Record<string, string>>;
  /**
   * Workflow-scoped values explicitly referenced by source as `ctx.secrets.NAME`.
   * Names are fixed at build time; provider connection credentials are never exposed here.
   *
   * The host supplies each secret value. Do not log it or return it in output.
   */
  readonly secrets: Readonly<Record<string, string>>;
  /** The declared trigger that started this run. */
  trigger: WorkflowTriggerContext;
  /**
   * Emit a human-readable annotation into the run's activity log — e.g.
   * `ctx.log("analyzing emails", { count })`. Annotations are ordered relative to
   * steps and surfaced in the run timeline and run history. Logging is
   * observational only: it never alters control flow and its result is discarded.
   * Do not log secrets or credential values.
   */
  log: LogFn;
  now(): number;
  random(): number;
  integrations: WorkflowIntegrations;
}

export interface LogFn {
  (message: string, data?: Record<string, unknown>): void;
}

export type Trigger =
  | ScheduleTrigger
  | ManualTrigger
  | OnceTrigger
  | WebhookTrigger
  | EventTrigger;

export interface ScheduleTrigger {
  type: "schedule";
  key: string;
  cron: string;
  tz?: string;
}

export interface ManualTrigger {
  type: "manual";
  key: string;
}

export interface OnceTrigger {
  type: "once";
  key: string;
  at: string;
}

export type WebhookAuth = "signature" | "none";

/**
 * The sender a helper in `@wix/whenever-workflow-sdk/webhooks` declares. A signed helper also
 * selects the sender's verification; `standard-webhooks` covers every sender that follows the
 * Standard Webhooks specification. `wix-automations` cannot sign, so its endpoint is unverified.
 */
export type WebhookProvider =
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
  | "wix-automations";

export interface WebhookTrigger {
  type: "webhook";
  name?: string;
  key: string;
  auth?: WebhookAuth;
  provider?: WebhookProvider;
  event?: string;
}

export interface EventTrigger {
  type: "event";
  key: string;
  source: string;
  config: Readonly<Record<string, unknown>>;
}
