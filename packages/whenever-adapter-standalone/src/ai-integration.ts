import {
  AI_IMAGE_MODELS,
  AI_VIDEO_MODELS,
  type AiConversationResult,
  type AiImageModel,
  type AiIntegration,
  type AiToolCall,
  type AiVideoModel,
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
  AI_REASONING_EFFORTS,
  AI_TOOL_LIMIT,
  type AiConversationRequest,
  type AiGenerateTextRequest,
  type AiPromptRequest,
  isAiConversationRequest,
} from "./ai-text-request";

export interface AiGenerateImageRequest {
  readonly prompt: string;
  readonly model?: AiImageModel;
}

export interface AiGenerateVideoRequest {
  readonly prompt: string;
  readonly model?: AiVideoModel;
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

export type AiGenerateVideoPort = (
  request: AiGenerateVideoRequest,
  call: AiGenerationCall,
) => Promise<{ readonly videoUrl: string; readonly usage?: AiUsage }>;

export interface AiIntegrationOptions {
  generateImage: AiGenerateImagePort;
  generateText: AiGenerateTextPort;
  generateVideo: AiGenerateVideoPort;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function prepareAiGenerateTextInput(input: unknown): AiGenerateTextRequest {
  return prepareAiTextRequest(input);
}

function prepareAiMediaRequest<TModel extends string>(
  kind: "image" | "video",
  models: readonly TModel[],
  input: unknown,
): { readonly prompt: string; readonly model?: TModel } {
  if (!isPlainRecord(input)) {
    throw invalidAiRequest(kind, "input must be an object");
  }
  const { prompt, model } = input;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw invalidAiRequest(kind, "prompt must be a non-empty string");
  }
  if (prompt.length > AI_PROMPT_LIMIT_CHARACTERS) {
    throw invalidAiRequest(
      kind,
      `prompt exceeds ${String(AI_PROMPT_LIMIT_CHARACTERS)} characters`,
    );
  }
  if (model === undefined) return { prompt };
  if (!models.includes(model as TModel)) {
    throw invalidAiRequest(
      kind,
      `model must be one of ${models.map((value) => JSON.stringify(value)).join(", ")}`,
    );
  }
  return { prompt, model: model as TModel };
}

export function prepareAiGenerateImageInput(
  input: unknown,
): AiGenerateImageRequest {
  return prepareAiMediaRequest("image", AI_IMAGE_MODELS, input);
}

export function prepareAiGenerateVideoInput(
  input: unknown,
): AiGenerateVideoRequest {
  return prepareAiMediaRequest("video", AI_VIDEO_MODELS, input);
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
  generateVideo,
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
    async generateVideo(input) {
      const request = prepareAiGenerateVideoInput(input);
      const generated = await generateVideo(request, call);
      if (
        !isPlainRecord(generated) ||
        typeof generated.videoUrl !== "string" ||
        !generated.videoUrl.trim()
      ) {
        throw new RetryableError("The model returned no generated video", {
          code: "AI_GENERATION_EMPTY",
          operation: "ai.generateVideo",
        });
      }
      return { videoUrl: generated.videoUrl };
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

export function unavailableAiGenerateVideo(): AiGenerateVideoPort {
  return () => {
    throw new NonRetryableError(
      "AI video generation requires a host-supplied generation port",
      { code: "AI_GENERATION_UNAVAILABLE", operation: "ai.generateVideo" },
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
