/** One-shot generation: an instruction and its content in `prompt`, optionally steered by `system`. */
export interface AiGenerateTextInput {
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
export interface AiConversationInput<TTools extends AiTools = AiTools> {
  prompt?: never;
  system?: string;
  messages: readonly AiMessage[];
  tools: TTools;
  toolChoice?: AiToolChoice<NoInfer<keyof TTools & string>>;
}

export interface AiConversationTextInput {
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

export interface AiGenerateImageInput {
  prompt: string;
}

export interface AiGenerateImageResult {
  imageUrl: string;
}

export interface AiIntegration {
  /**
   * Generates text from one prompt and returns it. Put everything the model needs — the
   * instruction and the content it works on — into `prompt`, optionally with a standing
   * instruction in `system`, and read the answer from `result.text`. There are no model,
   * temperature or length settings here; the host supplies the generation implementation and
   * configures its model and deadlines.
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

  /**
   * Generates one image from a prompt and returns its URL. Put the complete visual description in
   * `prompt`, and read the generated image from `result.imageUrl`. The host supplies the generation
   * implementation and configures its model, image settings and deadlines.
   */
  generateImage(input: AiGenerateImageInput): Promise<AiGenerateImageResult>;
}

export interface HttpRequestInput {
  url: string;
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
