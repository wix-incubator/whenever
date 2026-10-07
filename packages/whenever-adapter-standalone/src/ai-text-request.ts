import {
  type AiMessage,
  type AiTool,
  type AiToolCall,
  type AiToolChoice,
  type AiTools,
  NonRetryableError,
} from "@wix/whenever-workflow-sdk";

export const AI_PROMPT_LIMIT_CHARACTERS = 100_000;
// A loop resends every tool result it has gathered, so a conversation outgrows a single prompt.
export const AI_CONVERSATION_LIMIT_CHARACTERS = 1_000_000;
export const AI_CONVERSATION_MESSAGE_LIMIT = 200;
export const AI_TOOL_LIMIT = 64;

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

export interface AiPromptRequest {
  readonly prompt: string;
  readonly system?: string;
}

export interface AiConversationRequest {
  readonly system?: string;
  readonly messages: readonly AiMessage[];
  readonly tools?: AiTools;
  readonly toolChoice?: AiToolChoice;
}

export type AiGenerateTextRequest = AiPromptRequest | AiConversationRequest;

export function isAiConversationRequest(
  request: AiGenerateTextRequest,
): request is AiConversationRequest {
  return "messages" in request;
}

export function invalidAiRequest(
  kind: "image" | "text",
  message: string,
): NonRetryableError {
  return new NonRetryableError(`Invalid AI ${kind} generation: ${message}.`, {
    code: "INVALID_AI_REQUEST",
  });
}

function invalid(message: string): NonRetryableError {
  return invalidAiRequest("text", message);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasOwnKey(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// JSON serialization omits undefined properties, so validation treats them as absent.
function definedEntries(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

function requireOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw invalid(`${where} does not take ${unknown.join(", ")}`);
  }
}

function nonEmptyText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalid(`${name} must be a non-empty string`);
  }
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  return value;
}

export function prepareAiTextRequest(input: unknown): AiGenerateTextRequest {
  if (!isPlainRecord(input)) throw invalid("input must be an object");
  const fields = definedEntries(input);
  if ("messages" in fields) return prepareConversation(fields);
  requireOnlyKeys(fields, ["prompt", "system"], "a prompt call");
  const prompt = nonEmptyText(fields.prompt, "prompt");
  const system =
    fields.system === undefined ? undefined : nonEmptyText(fields.system, "system");
  if (prompt.length + (system?.length ?? 0) > AI_PROMPT_LIMIT_CHARACTERS) {
    throw invalid(`prompt exceeds ${String(AI_PROMPT_LIMIT_CHARACTERS)} characters`);
  }
  return system === undefined ? { prompt } : { prompt, system };
}

function prepareConversation(fields: Record<string, unknown>): AiConversationRequest {
  requireOnlyKeys(fields, ["system", "messages", "tools", "toolChoice"], "a conversation");
  const system =
    fields.system === undefined ? undefined : nonEmptyText(fields.system, "system");
  const tools = fields.tools === undefined ? undefined : prepareTools(fields.tools);
  const toolChoice =
    fields.toolChoice === undefined
      ? undefined
      : prepareToolChoice(fields.toolChoice, tools);
  const messages = prepareMessages(fields.messages);

  const characters =
    (system?.length ?? 0) +
    messages.reduce((total, message) => total + message.content.length, 0) +
    Object.values(tools ?? {}).reduce(
      (total, tool) => total + tool.description.length + JSON.stringify(tool.parameters).length,
      0,
    );
  if (characters > AI_CONVERSATION_LIMIT_CHARACTERS) {
    throw invalid(
      `the conversation exceeds ${String(AI_CONVERSATION_LIMIT_CHARACTERS)} characters`,
    );
  }

  return {
    ...(system === undefined ? {} : { system }),
    messages,
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
  };
}

function prepareTools(value: unknown): AiTools {
  if (!isPlainRecord(value)) throw invalid("tools must be a record keyed by tool name");
  const entries = Object.entries(value);
  if (entries.length > AI_TOOL_LIMIT) {
    throw invalid(`at most ${String(AI_TOOL_LIMIT)} tools can be offered`);
  }
  return Object.fromEntries(
    entries.map(([name, tool]) => [name, prepareTool(name, tool)]),
  );
}

function prepareTool(name: string, value: unknown): AiTool {
  if (!TOOL_NAME.test(name)) {
    throw invalid(`tool name ${JSON.stringify(name)} must be 1-64 letters, digits, _ or -`);
  }
  if (!isPlainRecord(value)) throw invalid(`tool ${name} must be an object`);
  const tool = definedEntries(value);
  requireOnlyKeys(tool, ["description", "parameters"], `tool ${name}`);
  const description = nonEmptyText(tool.description, `tool ${name} description`);
  const parameters = tool.parameters;
  if (!isPlainRecord(parameters) || parameters.type !== "object") {
    throw invalid(`tool ${name} parameters must be a JSON Schema object with type "object"`);
  }
  return { description, parameters: { ...parameters, type: "object" } };
}

function prepareToolChoice(value: unknown, tools: AiTools | undefined): AiToolChoice {
  if (tools === undefined) throw invalid("toolChoice needs tools");
  if (value === "auto" || value === "required") return value;
  if (isPlainRecord(value)) {
    const choice = definedEntries(value);
    requireOnlyKeys(choice, ["name"], "toolChoice");
    if (typeof choice.name === "string" && hasOwnKey(tools, choice.name)) {
      return { name: choice.name };
    }
  }
  throw invalid('toolChoice must be "auto", "required" or { name } of an offered tool');
}

function prepareMessages(value: unknown): AiMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid("messages must be a non-empty list");
  }
  if (value.length > AI_CONVERSATION_MESSAGE_LIMIT) {
    throw invalid(`messages holds more than ${String(AI_CONVERSATION_MESSAGE_LIMIT)} entries`);
  }
  const seenCallIds = new Set<string>();
  let unanswered = new Set<string>();
  const messages = value.map((entry: unknown, index): AiMessage => {
    const where = `messages[${String(index)}]`;
    if (!isPlainRecord(entry)) throw invalid(`${where} must be an object`);
    const message = definedEntries(entry);
    if (message.role === "tool") {
      requireOnlyKeys(message, ["role", "toolCallId", "content"], where);
      const toolCallId = text(message.toolCallId, `${where}.toolCallId`);
      if (!unanswered.delete(toolCallId)) {
        throw invalid(`${where} answers no open tool call`);
      }
      return { role: "tool", toolCallId, content: text(message.content, `${where}.content`) };
    }
    if (unanswered.size > 0) {
      throw invalid(`${where} follows a tool call that has no tool message answering it`);
    }
    if (message.role === "user") {
      requireOnlyKeys(message, ["role", "content"], where);
      return { role: "user", content: nonEmptyText(message.content, `${where}.content`) };
    }
    if (message.role === "assistant") {
      requireOnlyKeys(message, ["role", "content", "toolCalls", "providerState"], where);
      const content = text(message.content, `${where}.content`);
      const providerState =
        message.providerState === undefined ? undefined : text(message.providerState, `${where}.providerState`);
      const toolCalls =
        message.toolCalls === undefined
          ? undefined
          : prepareToolCalls(message.toolCalls, where, seenCallIds);
      unanswered = new Set(toolCalls?.map((call) => call.id));
      return {
        role: "assistant",
        content,
        ...(toolCalls === undefined ? {} : { toolCalls }),
        ...(providerState === undefined ? {} : { providerState }),
      };
    }
    throw invalid(`${where}.role must be "user", "assistant" or "tool"`);
  });
  if (unanswered.size > 0) {
    throw invalid("the last tool calls have no tool message answering them");
  }
  return messages;
}

function prepareToolCalls(
  value: unknown,
  where: string,
  seenCallIds: Set<string>,
): AiToolCall[] {
  if (!Array.isArray(value)) throw invalid(`${where}.toolCalls must be a list`);
  return value.map((entry: unknown, index): AiToolCall => {
    const at = `${where}.toolCalls[${String(index)}]`;
    if (!isPlainRecord(entry)) throw invalid(`${at} must be an object`);
    const call = definedEntries(entry);
    requireOnlyKeys(call, ["id", "name", "arguments"], at);
    const id = nonEmptyText(call.id, `${at}.id`);
    if (seenCallIds.has(id)) throw invalid(`${at}.id repeats an earlier tool call`);
    seenCallIds.add(id);
    return { id, name: nonEmptyText(call.name, `${at}.name`), arguments: call.arguments };
  });
}
