import type { WebhookProvider, WebhookTrigger } from "./types";

interface WebhookIdentity {
  /** Stable endpoint identity; changing it issues a different URL. */
  key: string;
  name?: string;
}

function providerWebhook(provider: WebhookProvider, identity: WebhookIdentity, auth?: "signature"): WebhookTrigger {
  const key = identity.key.trim();
  if (key === "") {
    throw new Error("invalid webhook key: expected a non-empty stable key");
  }
  const trigger: WebhookTrigger = { type: "webhook", key, ...(auth === undefined ? {} : { auth }), provider };
  if (identity.name !== undefined) trigger.name = identity.name;
  return trigger;
}

function signedWebhook(provider: WebhookProvider, identity: WebhookIdentity, event?: string): WebhookTrigger {
  const trigger = providerWebhook(provider, identity, "signature");
  if (event !== undefined) {
    const selected = event.trim();
    if (selected === "") {
      throw new Error("invalid webhook event: expected a non-empty event name from the sender's own vocabulary");
    }
    trigger.event = selected;
  }
  return trigger;
}

/**
 * WhatsApp Business Account messages from a Meta app's Webhooks product. Runs only for
 * `whatsapp_business_account` deliveries that carry messages; other objects and status receipts are
 * dropped by the host. The host must verify deliveries with the Meta app secret and answer Meta's
 * registration check with the configured verify token.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export function metaAppWhatsAppWebhook(options: WebhookIdentity): WebhookTrigger {
  return signedWebhook("meta", options);
}

/**
 * Events from a Slack app's Event Subscriptions. The host must verify deliveries with the Slack
 * signing secret and drop the bot's own messages. `event`
 * narrows the endpoint to one Slack event, named in Slack's vocabulary: `"app_mention"`, not
 * `"slack.app_mention"`.
 *
 * @see https://api.slack.com/apis/events-api
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function slackAppEventsWebhook(options: WebhookIdentity & { event?: string }): WebhookTrigger {
  return signedWebhook("slack", options, options.event);
}

/**
 * Stripe events. The host must verify deliveries with the endpoint's `whsec_…` signing secret and
 * refuse deliveries older than five minutes.
 *
 * @see https://docs.stripe.com/webhooks#verify-manually
 */
export function stripeWebhook(options: WebhookIdentity): WebhookTrigger {
  return signedWebhook("stripe", options);
}

/**
 * GitHub repository, organization or GitHub App webhook events. The host must verify deliveries
 * with the configured webhook secret.
 *
 * @see https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
export function githubWebhook(options: WebhookIdentity): WebhookTrigger {
  return signedWebhook("github", options);
}

/**
 * Shopify store events, from a webhook created in the store admin or subscribed by an app. Verified
 * by the host with the key Shopify signs with: the signing key the admin's
 * Webhooks page shows, or the app's client secret.
 *
 * @see https://shopify.dev/docs/apps/build/webhooks/subscribe/https
 */
export function shopifyWebhook(options: WebhookIdentity): WebhookTrigger {
  return signedWebhook("shopify", options);
}

/**
 * Any sender following the Standard Webhooks specification. The host must verify deliveries with
 * the sender's `whsec_…` secret and refuse deliveries older than five minutes.
 *
 * @see https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 */
export function standardWebhook(options: WebhookIdentity): WebhookTrigger {
  return signedWebhook("standard-webhooks", options);
}

/**
 * A Discord app's Interactions Endpoint URL: slash commands, buttons and modal submissions. Neither
 * Discord helper receives channel messages or member joins; Discord sends those only over its
 * Gateway. The host must verify deliveries with the app's public key, answer PING and defer each
 * interaction; the workflow replies within fifteen minutes through its follow-up webhook
 * (`application_id` and `token` on the input).
 *
 * @see https://docs.discord.com/developers/interactions/receiving-and-responding
 */
export function discordAppInteractionsWebhook(options: WebhookIdentity): WebhookTrigger {
  return signedWebhook("discord", options);
}

/**
 * A Discord app's Webhook Events: the app authorized or deauthorized, entitlements, Social SDK
 * messages. The host must verify deliveries with the app's public key; `ctx.trigger.eventType` is Discord's
 * event name, such as `"APPLICATION_AUTHORIZED"`.
 *
 * @see https://docs.discord.com/developers/events/webhook-events
 */
export function discordAppEventsWebhook(options: WebhookIdentity): WebhookTrigger {
  return signedWebhook("discord-events", options);
}

/**
 * A Telegram bot's updates, verified with the `secret_token` given to `setWebhook`, from the
 * host's configured credentials.
 *
 * @see https://core.telegram.org/bots/api#setwebhook
 */
export function telegramBotWebhook(options: WebhookIdentity): WebhookTrigger {
  return signedWebhook("telegram", options);
}

/**
 * A Wix app's webhooks: app events such as `AppInstalled` and site events such as
 * `wix.ecom.v1.order_created`. The host must verify Wix's JWT with the app's configured public key
 * and decode it: `ctx.input` is `{ eventType, instanceId, data,
 * identity }`, already parsed, and `ctx.trigger.eventType` is Wix's event type.
 *
 * @see https://dev.wix.com/docs/build-apps/develop-your-app/api-integrations/events-and-webhooks/about-webhooks
 */
export function wixAppWebhook(options: WebhookIdentity): WebhookTrigger {
  return signedWebhook("wix-app", options);
}

/**
 * A Wix Automations "Send HTTP request" action; `ctx.input` is its JSON body. Wix Automations
 * cannot sign or add headers, so this endpoint is unverified: anyone holding its URL can start a run.
 *
 * @see https://support.wix.com/en/article/the-new-automation-builder-sending-data-via-webhook
 */
export function wixAutomationsWebhook(options: WebhookIdentity): WebhookTrigger {
  return providerWebhook("wix-automations", options);
}
