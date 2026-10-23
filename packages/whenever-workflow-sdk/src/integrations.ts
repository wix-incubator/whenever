/** How long a model reasons before it answers; more effort is slower and costs more. */
export type AiReasoningEffort = "low" | "medium" | "high";

/** The models `ai.generateText` can run on. */
export const AI_TEXT_MODELS = [
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-5.5",
  "google/gemini-3.1-pro",
  "google/gemini-3.5-flash",
  "google/gemini-3.8-flash",
  "google/gemini-4-argon",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.6-luna",
  "openai/gpt-6-luna",
  "openai/gpt-6-sol",
  "openai/gpt-6.1-sol",
] as const;

export type AiTextModel = (typeof AI_TEXT_MODELS)[number];

/** Models that cannot be forced to call a tool: use `toolChoice: "auto"` or omit it with them. */
export const AI_TEXT_MODELS_WITHOUT_FORCED_TOOL_CHOICE = [
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-5.5",
] as const satisfies readonly AiTextModel[];

/** Settings every text generation accepts. Omit them for the host's defaults. */
export interface AiGenerationSettings {
  model?: AiTextModel;
  reasoningEffort?: AiReasoningEffort;
}

/** One-shot generation: an instruction and its content in `prompt`, optionally steered by `system`. */
export interface AiGenerateTextInput extends AiGenerationSettings {
  prompt: string;
  system?: string;
  messages?: never;
  tools?: never;
  toolChoice?: never;
}

export interface AiGenerateTextResult {
  text: string;
}

/** A JSON Schema object describing a tool's arguments. */
export interface AiToolParameters {
  readonly type: "object";
  readonly [keyword: string]: unknown;
}

export interface AiTool {
  readonly description: string;
  readonly parameters: AiToolParameters;
}

/** Tools the model may call, keyed by tool name (letters, digits, `_` and `-`, at most 64). */
export type AiTools = Readonly<Record<string, AiTool>>;

export interface AiToolCall<TName extends string = string> {
  /** Answer this call with a `tool` message carrying the same `toolCallId`. */
  readonly id: string;
  readonly name: TName;
  /** The model's arguments, parsed from JSON, or the raw string when they are not JSON. Validate before use. */
  readonly arguments: unknown;
}

export interface AiUserMessage {
  readonly role: "user";
  readonly content: string;
}

export interface AiAssistantMessage<TName extends string = string> {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls?: readonly AiToolCall<TName>[];
  /** Opaque model state carried to the next turn. Pass it back unchanged; never read or build it. */
  readonly providerState?: string;
}

export interface AiToolMessage {
  readonly role: "tool";
  readonly toolCallId: string;
  readonly content: string;
}

export type AiMessage =
  | AiUserMessage
  | AiAssistantMessage
  | AiToolMessage;

export type AiToolChoice<TName extends string = string> =
  | "auto"
  | "required"
  | { readonly name: TName };

/** A turn of a conversation: the whole history so far, oldest first. */
export interface AiConversationInput<TTools extends AiTools = AiTools>
  extends AiGenerationSettings {
  prompt?: never;
  system?: string;
  messages: readonly AiMessage[];
  tools: TTools;
  toolChoice?: AiToolChoice<NoInfer<keyof TTools & string>>;
}

export interface AiConversationTextInput extends AiGenerationSettings {
  prompt?: never;
  system?: string;
  messages: readonly AiMessage[];
  tools?: never;
  toolChoice?: never;
}

export interface AiConversationTextResult {
  readonly finishReason: "stop";
  readonly text: string;
  /** Append this to `messages` before the next turn. */
  readonly message: AiAssistantMessage<never>;
}

export interface AiConversationToolCallsResult<TName extends string = string> {
  readonly finishReason: "tool-calls";
  readonly toolCalls: readonly [AiToolCall<TName>, ...AiToolCall<TName>[]];
  /** Append this to `messages`, then one `tool` message per call, before the next turn. */
  readonly message: AiAssistantMessage<TName>;
}

export type AiConversationResult<TName extends string = string> =
  | (Omit<AiConversationTextResult, "message"> & {
      readonly message: AiAssistantMessage<TName>;
    })
  | AiConversationToolCallsResult<TName>;

/** The models `ai.generateImage` can run on. */
export const AI_IMAGE_MODELS = [
  "google/nano-banana-2.1",
  "openai/gpt-image-2.5",
] as const;

export type AiImageModel = (typeof AI_IMAGE_MODELS)[number];

/** The models `ai.generateVideo` can run on. */
export const AI_VIDEO_MODELS = [
  "google/veo-3.1-fast",
  "kling/kling-3.0-pro",
] as const;

export type AiVideoModel = (typeof AI_VIDEO_MODELS)[number];

export const AI_ASPECT_RATIOS = ["1:1", "16:9", "9:16"] as const;

export type AiAspectRatio = (typeof AI_ASPECT_RATIOS)[number];

export const AI_VIDEO_RESOLUTIONS = ["720p", "1080p"] as const;

export type AiVideoResolution = (typeof AI_VIDEO_RESOLUTIONS)[number];

/** Omit a setting for the host's default; a combination the chosen model cannot render is refused. */
export interface AiGenerateImageInput {
  prompt: string;
  model?: AiImageModel;
  aspectRatio?: AiAspectRatio;
}

export interface AiGenerateImageResult {
  imageUrl: string;
}

/** Omit a setting for the host's default; a combination the chosen model cannot render is refused. */
export interface AiGenerateVideoInput {
  prompt: string;
  model?: AiVideoModel;
  aspectRatio?: AiAspectRatio;
  durationSeconds?: number;
  resolution?: AiVideoResolution;
}

export interface AiGenerateVideoResult {
  videoUrl: string;
}

export interface AiIntegration {
  /**
   * Generates text from one prompt and returns it. Put everything the model needs — the
   * instruction and the content it works on — into `prompt`, optionally with a standing
   * instruction in `system`, and read the answer from `result.text`. `model` and
   * `reasoningEffort` pick among the models the host offers; the host configures deadlines.
   */
  generateText(input: AiGenerateTextInput): Promise<AiGenerateTextResult>;

  /**
   * Continues a conversation without tools: pass the whole history in `messages` and read the
   * reply from `result.text`. Append `result.message` to continue it on a later call.
   */
  generateText(input: AiConversationTextInput): Promise<AiConversationTextResult>;

  /**
   * One turn of an agent loop. Pass the whole conversation history in
   * `messages` on every call. On `finishReason: "tool-calls"`, append `result.message`, run each
   * call yourself through `ctx.integrations`, append one `tool` message per call with its
   * `toolCallId`, and call again. On `"stop"`, `result.text` is the answer. The model never runs a
   * tool. Validate `arguments` before use, and cap the number of turns and tool calls.
   */
  generateText<const TTools extends AiTools>(
    input: AiConversationInput<TTools>,
  ): Promise<AiConversationResult<keyof TTools & string>>;

  /** One image from a complete visual prompt; `result.imageUrl` opens for anyone holding it. */
  generateImage(input: AiGenerateImageInput): Promise<AiGenerateImageResult>;

  /** One short clip from a complete scene prompt, in minutes; `result.videoUrl` opens for anyone holding it. */
  generateVideo(input: AiGenerateVideoInput): Promise<AiGenerateVideoResult>;
}

export interface HttpRequestInput {
  url: string;
  /**
   * Names a connection the host holds. The host adds that connection's credentials and refuses a
   * `url` outside its address, so the workflow passes no credential header of its own.
   */
  connection?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

export interface HttpWriteInput extends HttpRequestInput {
  body?: unknown;
}

export interface HttpResponseResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type HttpWriteResult = HttpResponseResult;

export interface HttpIntegration {
  get(input: HttpRequestInput): Promise<HttpResponseResult>;
  post(input: HttpWriteInput): Promise<HttpWriteResult>;
  put(input: HttpWriteInput): Promise<HttpWriteResult>;
  /** Performs a guarded PATCH; uncertainty is never automatically retried. */
  patch(input: HttpWriteInput): Promise<HttpWriteResult>;
}

export interface McpToolCallInput {
  url: string;
  toolName: string;
  toolProps?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface McpToolResult {
  structuredContent: unknown;
  content: unknown;
}

export interface McpIntegration {
  /** Calls a tool that only reads, on an author-supplied MCP server. */
  read(input: McpToolCallInput): Promise<McpToolResult>;
  /**
   * Calls a tool that may change remote state. The tool a caller names decides which member
   * applies, so uncertainty here is never automatically retried.
   */
  write(input: McpToolCallInput): Promise<McpToolResult>;
}

export interface PostgresQueryInput {
  sql: string;
  params?: readonly unknown[];
  maxRows?: number;
}

export interface PostgresQueryResult {
  rows: unknown;
  rowCount: number;
  truncated: boolean;
}

/**
 * A host-supplied, credential-backed Postgres port. The host owns the connection; workflow source
 * never receives its password. Implementations must enforce read-only access and row/size bounds.
 */
export interface WorkflowPostgres {
  /**
   * Runs one parameterized SQL statement against the owner's connected Postgres in a read-only
   * transaction. Pass `sql` and optional `params` (`$1`, `$2`, …). Read `result.rows` as unknown
   * and narrow before use. `truncated` is true when the row cap or the size cap stopped the
   * result, so it is never a complete table. A write is refused. The host, user and password come
   * from the Postgres connection, never from this input.
   */
  query(input: PostgresQueryInput): Promise<PostgresQueryResult>;
}

/**
 * Everything a workflow can call. `ai`, `http`, `mcp` and `postgres` are the members declared
 * here; every other provider operation is added by binding it, which declares its own member by
 * augmenting this interface with a host-supplied declaration module.
 */
export interface WorkflowIntegrations {
  ai: AiIntegration;
  http: HttpIntegration;
  mcp: McpIntegration;
  postgres: WorkflowPostgres;
}
