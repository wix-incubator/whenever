import {
  type AiConversationResult,
  type AiIntegration,
  type AiToolCall,
  NonRetryableError,
  RetryableError,
} from "@wix/whenever-workflow-sdk";

import {
  AI_PROMPT_LIMIT_CHARACTERS,
  type AiConversationRequest,
  type AiGenerateTextRequest,
  hasOwnKey,
  invalidAiRequest,
  isAiConversationRequest,
  isPlainRecord,
  prepareAiTextRequest,
} from "./ai-text-request";

export {
  AI_CONVERSATION_LIMIT_CHARACTERS,
  AI_CONVERSATION_MESSAGE_LIMIT,
  AI_PROMPT_LIMIT_CHARACTERS,
  AI_TOOL_LIMIT,
  type AiConversationRequest,
  type AiGenerateTextRequest,
  type AiPromptRequest,
  isAiConversationRequest,
} from "./ai-text-request";

export interface AiGenerateImageRequest {
  readonly prompt: string;
}

export interface AiGenerationCall {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type AiGenerateTextCall = AiGenerationCall;

export interface AiUsage {
  readonly model: string;
  readonly microcents: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** What the model produced, before it is shaped into the result the workflow asked for. */
export interface AiTextGeneration {
  readonly text: string;
  readonly toolCalls?: readonly AiToolCall[];
  readonly providerState?: string;
}

export type AiGenerateTextPort = (
  request: AiGenerateTextRequest,
  call: AiGenerationCall,
) => Promise<AiTextGeneration & { readonly usage?: AiUsage }>;

export type AiGenerateImagePort = (
  request: AiGenerateImageRequest,
  call: AiGenerationCall,
) => Promise<{ readonly imageUrl: string; readonly usage?: AiUsage }>;

export interface AiIntegrationOptions {
  generateImage: AiGenerateImagePort;
  generateText: AiGenerateTextPort;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function prepareAiGenerateTextInput(input: unknown): AiGenerateTextRequest {
  return prepareAiTextRequest(input);
}

export function prepareAiGenerateImageInput(
  input: unknown,
): AiGenerateImageRequest {
  if (!isPlainRecord(input)) {
    throw invalidAiRequest("image", "input must be an object");
  }
  const { prompt } = input;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw invalidAiRequest("image", "prompt must be a non-empty string");
  }
  if (prompt.length > AI_PROMPT_LIMIT_CHARACTERS) {
    throw invalidAiRequest(
      "image",
      `prompt exceeds ${String(AI_PROMPT_LIMIT_CHARACTERS)} characters`,
    );
  }
  return { prompt };
}

function emptyTextGeneration(): RetryableError {
  return new RetryableError("The model returned no generated text", {
    code: "AI_GENERATION_EMPTY",
    operation: "ai.generateText",
  });
}

function hasText(generated: unknown): generated is { readonly text: string } {
  return (
    isPlainRecord(generated) &&
    typeof generated.text === "string" &&
    generated.text.trim() !== ""
  );
}

/**
 * Shapes a generation into one conversation turn. A turn that calls tools always names at least
 * one call, and a turn that stops always carries text, so the workflow never sees neither.
 */
export function aiConversationTurn(
  generated: AiTextGeneration,
): AiConversationResult | undefined {
  const toolCalls = generated.toolCalls ?? [];
  const providerState =
    generated.providerState === undefined ? {} : { providerState: generated.providerState };
  const [first, ...rest] = toolCalls;
  if (first !== undefined) {
    const calls: [AiToolCall, ...AiToolCall[]] = [first, ...rest];
    return {
      finishReason: "tool-calls",
      toolCalls: calls,
      message: {
        role: "assistant",
        content: generated.text,
        toolCalls: calls,
        ...providerState,
      },
    };
  }
  if (!hasText(generated)) return undefined;
  return {
    finishReason: "stop",
    text: generated.text,
    message: { role: "assistant", content: generated.text, ...providerState },
  };
}

function conversationTurn(
  request: AiConversationRequest,
  generated: AiTextGeneration,
): AiConversationResult {
  if (!isPlainRecord(generated) || typeof generated.text !== "string") {
    throw emptyTextGeneration();
  }
  const offered = request.tools ?? {};
  const undeclared = (generated.toolCalls ?? []).find(
    (call) => !hasOwnKey(offered, call.name),
  );
  if (undeclared !== undefined) {
    throw new RetryableError("The model called a tool it was not offered", {
      code: "AI_GENERATION_INVALID",
      operation: "ai.generateText",
    });
  }
  const turn = aiConversationTurn(generated);
  if (turn === undefined) throw emptyTextGeneration();
  return turn;
}

export function createAiIntegration({
  generateImage,
  generateText,
  timeoutMs,
  signal,
}: AiIntegrationOptions): AiIntegration {
  const call: AiGenerationCall = {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(signal === undefined ? {} : { signal }),
  };
  return {
    async generateImage(input) {
      const request = prepareAiGenerateImageInput(input);
      const generated = await generateImage(request, call);
      if (
        !isPlainRecord(generated) ||
        typeof generated.imageUrl !== "string" ||
        !generated.imageUrl.trim()
      ) {
        throw new RetryableError("The model returned no generated image", {
          code: "AI_GENERATION_EMPTY",
          operation: "ai.generateImage",
        });
      }
      return { imageUrl: generated.imageUrl };
    },
    generateText: (async (input: unknown) => {
      const request = prepareAiGenerateTextInput(input);
      const generated = await generateText(request, call);
      if (isAiConversationRequest(request)) {
        return conversationTurn(request, generated);
      }
      if (!hasText(generated)) throw emptyTextGeneration();
      return { text: generated.text };
    }) as AiIntegration["generateText"],
  };
}

export function unavailableAiGenerateImage(): AiGenerateImagePort {
  return () => {
    throw new NonRetryableError(
      "AI image generation requires a host-supplied generation port",
      { code: "AI_GENERATION_UNAVAILABLE", operation: "ai.generateImage" },
    );
  };
}

export function unavailableAiGenerateText(): AiGenerateTextPort {
  return () => {
    throw new NonRetryableError(
      "AI text generation requires a host-supplied generation port",
      { code: "AI_GENERATION_UNAVAILABLE", operation: "ai.generateText" },
    );
  };
}
