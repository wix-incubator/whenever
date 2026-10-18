import {
  AI_ASPECT_RATIOS,
  AI_IMAGE_MODELS,
  AI_VIDEO_MODELS,
  AI_VIDEO_RESOLUTIONS,
  type AiAspectRatio,
  type AiConversationResult,
  type AiImageModel,
  type AiIntegration,
  type AiToolCall,
  type AiVideoModel,
  type AiVideoResolution,
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
  readonly aspectRatio?: AiAspectRatio;
}

export interface AiGenerateVideoRequest {
  readonly prompt: string;
  readonly model?: AiVideoModel;
  readonly aspectRatio?: AiAspectRatio;
  readonly durationSeconds?: number;
  readonly resolution?: AiVideoResolution;
}

/** Longest clip any host can be asked for; which lengths a model accepts is the host's call. */
export const AI_VIDEO_DURATION_LIMIT_SECONDS = 60;

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

function oneOf<TValue extends string>(
  kind: "image" | "video",
  field: string,
  values: readonly TValue[],
  value: unknown,
): TValue | undefined {
  if (value === undefined) return undefined;
  if (!values.includes(value as TValue)) {
    throw invalidAiRequest(
      kind,
      `${field} must be one of ${values.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  }
  return value as TValue;
}

function prepareAiMediaRequest<TModel extends string>(
  kind: "image" | "video",
  models: readonly TModel[],
  input: unknown,
): {
  readonly prompt: string;
  readonly model?: TModel;
  readonly aspectRatio?: AiAspectRatio;
} {
  if (!isPlainRecord(input)) {
    throw invalidAiRequest(kind, "input must be an object");
  }
  const { prompt } = input;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw invalidAiRequest(kind, "prompt must be a non-empty string");
  }
  if (prompt.length > AI_PROMPT_LIMIT_CHARACTERS) {
    throw invalidAiRequest(
      kind,
      `prompt exceeds ${String(AI_PROMPT_LIMIT_CHARACTERS)} characters`,
    );
  }
  const model = oneOf(kind, "model", models, input.model);
  const aspectRatio = oneOf(kind, "aspectRatio", AI_ASPECT_RATIOS, input.aspectRatio);
  return {
    prompt,
    ...(model === undefined ? {} : { model }),
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
  };
}

export function prepareAiGenerateImageInput(
  input: unknown,
): AiGenerateImageRequest {
  return prepareAiMediaRequest("image", AI_IMAGE_MODELS, input);
}

export function prepareAiGenerateVideoInput(
  input: unknown,
): AiGenerateVideoRequest {
  const request = prepareAiMediaRequest("video", AI_VIDEO_MODELS, input);
  const { durationSeconds } = input as Record<string, unknown>;
  if (
    durationSeconds !== undefined &&
    (typeof durationSeconds !== "number" ||
      !Number.isInteger(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > AI_VIDEO_DURATION_LIMIT_SECONDS)
  ) {
    throw invalidAiRequest(
      "video",
      `durationSeconds must be a whole number from 1 to ${String(AI_VIDEO_DURATION_LIMIT_SECONDS)}`,
    );
  }
  const resolution = oneOf(
    "video",
    "resolution",
    AI_VIDEO_RESOLUTIONS,
    (input as Record<string, unknown>).resolution,
  );
  return {
    ...request,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(resolution === undefined ? {} : { resolution }),
  };
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
