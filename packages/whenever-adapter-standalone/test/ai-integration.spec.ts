import { NonRetryableError, RetryableError } from "@wix/whenever-workflow-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  AI_CONVERSATION_LIMIT_CHARACTERS,
  AI_CONVERSATION_MESSAGE_LIMIT,
  AI_PROMPT_LIMIT_CHARACTERS,
  AI_TOOL_LIMIT,
  type AiGenerateImagePort,
  type AiGenerateTextPort,
  createAiIntegration,
  unavailableAiGenerateImage,
  unavailableAiGenerateText,
} from "../src/ai-integration";
import { createWorkflowIntegrationsFromEnv } from "../src/runtime";

function generating(text: string): AiGenerateTextPort {
  return vi.fn<AiGenerateTextPort>(async () => ({ text }));
}

function generatingImage(imageUrl: string): AiGenerateImagePort {
  return vi.fn<AiGenerateImagePort>(async () => ({ imageUrl }));
}

describe("createAiIntegration", () => {
  it("keeps the port's usage out of what the workflow receives", async () => {
    const usage = { model: "model-1", microcents: 1234 };
    const integration = createAiIntegration({
      generateImage: vi.fn<AiGenerateImagePort>(async () => ({
        imageUrl: "https://images.example.test/generated.png",
        usage,
      })),
      generateText: vi.fn<AiGenerateTextPort>(async () => ({ text: "done", usage })),
    });

    await expect(integration.generateText({ prompt: "Say done." })).resolves.toEqual({
      text: "done",
    });
    await expect(integration.generateImage({ prompt: "Draw it." })).resolves.toEqual({
      imageUrl: "https://images.example.test/generated.png",
    });
  });

  it("hands the validated prompt to the image port and returns only its URL", async () => {
    const generateImage = generatingImage(
      "https://images.example.test/generated.png",
    );
    const integration = createAiIntegration({
      generateImage,
      generateText: generating("unused"),
    });

    const result = await integration.generateImage({
      prompt: "A paper-cut workflow illustration.",
    });

    expect(result).toEqual({
      imageUrl: "https://images.example.test/generated.png",
    });
    expect(generateImage).toHaveBeenCalledWith(
      { prompt: "A paper-cut workflow illustration." },
      {},
    );
  });

  it("hands the validated prompt to the port and returns only its text", async () => {
    const generateText = generating("A short summary.");
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
    });

    const result = await integration.generateText({
      prompt: "Summarize the three renewals below.",
    });

    expect(result).toEqual({ text: "A short summary." });
    expect(generateText).toHaveBeenCalledWith(
      { prompt: "Summarize the three renewals below." },
      {},
    );
  });

  it("carries the invocation deadline and abort signal to the port", async () => {
    const generateText = generating("done");
    const signal = AbortSignal.timeout(1_000);
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
      timeoutMs: 25_000,
      signal,
    });

    await integration.generateText({ prompt: "Draft a note." });

    expect(generateText).toHaveBeenCalledWith(
      { prompt: "Draft a note." },
      { timeoutMs: 25_000, signal },
    );
  });

  it.each([
    { when: "the input is not an object", input: "a prompt" },
    { when: "no prompt is given", input: {} },
    { when: "the prompt is empty", input: { prompt: "" } },
    { when: "the prompt is whitespace", input: { prompt: "  \n " } },
    { when: "the prompt is not a string", input: { prompt: 7 } },
  ])("refuses the call before reaching a model when $when", async ({ input }) => {
    const generateText = generating("never");
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
    });

    await expect(integration.generateText(input as never)).rejects.toMatchObject(
      { code: "INVALID_AI_REQUEST", retryable: false },
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("refuses a prompt past the bounded length", async () => {
    const generateText = generating("never");
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
    });

    await expect(
      integration.generateText({
        prompt: "x".repeat(AI_PROMPT_LIMIT_CHARACTERS + 1),
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(generateText).not.toHaveBeenCalled();
  });

  it.each([
    { when: "the port answers with no text", value: {} },
    { when: "the text is empty", value: { text: "" } },
    { when: "the text is whitespace", value: { text: "   " } },
    { when: "the text is not a string", value: { text: 42 } },
  ])("reports a failure rather than an empty generation when $when", async ({
    value,
  }) => {
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText: (async () => value) as unknown as AiGenerateTextPort,
    });

    await expect(
      integration.generateText({ prompt: "Summarize." }),
    ).rejects.toMatchObject({ code: "AI_GENERATION_EMPTY", retryable: true });
  });

  it("lets a port failure through unchanged, so the trusted side owns the classification", async () => {
    const failure = new RetryableError("provider is unavailable", {
      code: "AI_PROVIDER_UNAVAILABLE",
    });
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText: () => {
        throw failure;
      },
    });

    await expect(
      integration.generateText({ prompt: "Summarize." }),
    ).rejects.toBe(failure);
  });

  it.each([{}, { imageUrl: "" }, { imageUrl: "   " }, { imageUrl: 42 }])(
    "reports a failure rather than an empty image generation for %j",
    async (value) => {
      const integration = createAiIntegration({
        generateImage: (async () => value) as unknown as AiGenerateImagePort,
        generateText: generating("unused"),
      });

      await expect(
        integration.generateImage({ prompt: "Illustrate this." }),
      ).rejects.toMatchObject({
        code: "AI_GENERATION_EMPTY",
        retryable: true,
      });
    },
  );
});

describe("a prompt with a standing instruction", () => {
  it("hands the system instruction to the port beside the prompt", async () => {
    const generateText = generating("Bonjour.");
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
    });

    await expect(
      integration.generateText({ system: "Answer in French.", prompt: "Say hello." }),
    ).resolves.toEqual({ text: "Bonjour." });
    expect(generateText).toHaveBeenCalledWith(
      { prompt: "Say hello.", system: "Answer in French." },
      {},
    );
  });

  it.each([
    { when: "it is empty", system: "" },
    { when: "it is whitespace", system: "  " },
    { when: "it is not a string", system: 3 },
  ])("refuses a system instruction when $when", async ({ system }) => {
    const generateText = generating("never");
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
    });

    await expect(
      integration.generateText({ prompt: "Hi.", system } as never),
    ).rejects.toMatchObject({ code: "INVALID_AI_REQUEST", retryable: false });
    expect(generateText).not.toHaveBeenCalled();
  });
});

const GET_ISSUE = {
  description: "Read one Jira issue by key.",
  parameters: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
  },
} as const;

function conversing(
  generation: Awaited<ReturnType<AiGenerateTextPort>>,
): AiGenerateTextPort {
  return vi.fn<AiGenerateTextPort>(async () => generation);
}

describe("a conversation", () => {
  it("hands the history and tools to the port and returns the tool calls as a turn", async () => {
    const generateText = conversing({
      text: "",
      toolCalls: [{ id: "call-1", name: "getIssue", arguments: { key: "ABC-1" } }],
      providerState: "opaque-1",
    });
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
    });
    const input = {
      system: "You administer Jira.",
      messages: [{ role: "user", content: "What is ABC-1?" }],
      tools: { getIssue: GET_ISSUE },
      toolChoice: "auto",
    } as const;

    const turn = await integration.generateText(input);

    expect(turn).toEqual({
      finishReason: "tool-calls",
      toolCalls: [{ id: "call-1", name: "getIssue", arguments: { key: "ABC-1" } }],
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "getIssue", arguments: { key: "ABC-1" } }],
        providerState: "opaque-1",
      },
    });
    expect(generateText).toHaveBeenCalledWith(input, {});
  });

  it("returns the text as a stopped turn once every tool call is answered", async () => {
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText: conversing({ text: "ABC-1 is open." }),
    });

    const turn = await integration.generateText({
      messages: [
        { role: "user", content: "What is ABC-1?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "getIssue", arguments: { key: "ABC-1" } }],
          providerState: "opaque-1",
        },
        { role: "tool", toolCallId: "call-1", content: '{"status":"open"}' },
      ],
      tools: { getIssue: GET_ISSUE },
    });

    expect(turn).toEqual({
      finishReason: "stop",
      text: "ABC-1 is open.",
      message: { role: "assistant", content: "ABC-1 is open." },
    });
  });

  it("reports a failure when the model calls a tool it was not given", async () => {
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText: conversing({
        text: "",
        toolCalls: [{ id: "call-1", name: "deleteIssue", arguments: {} }],
      }),
    });

    await expect(
      integration.generateText({
        messages: [{ role: "user", content: "Delete ABC-1." }],
        tools: { getIssue: GET_ISSUE },
      }),
    ).rejects.toMatchObject({ code: "AI_GENERATION_INVALID", retryable: true });
  });

  it("reports an empty generation when a turn has neither text nor tool calls", async () => {
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText: conversing({ text: " ", toolCalls: [] }),
    });

    await expect(
      integration.generateText({ messages: [{ role: "user", content: "Hi." }] }),
    ).rejects.toMatchObject({ code: "AI_GENERATION_EMPTY", retryable: true });
  });

  const user = { role: "user", content: "Hi." } as const;
  const called = {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-1", name: "getIssue", arguments: {} }],
  } as const;
  const answered = { role: "tool", toolCallId: "call-1", content: "{}" } as const;
  const tools = { getIssue: GET_ISSUE };

  it.each([
    { when: "a prompt comes with a history", input: { prompt: "Hi.", messages: [user] } },
    { when: "a prompt comes with tools", input: { prompt: "Hi.", tools } },
    { when: "there is neither a prompt nor a history", input: { system: "Be brief." } },
    { when: "a key belongs to neither shape", input: { messages: [user], temperature: 0 } },
    { when: "the history is empty", input: { messages: [] } },
    { when: "the history is not a list", input: { messages: user } },
    { when: "a message has an unknown role", input: { messages: [{ role: "system", content: "x" }] } },
    { when: "a user message is empty", input: { messages: [{ role: "user", content: " " }] } },
    { when: "a message carries an unknown key", input: { messages: [{ ...user, name: "a" }] } },
    { when: "a tool message answers no call", input: { messages: [user, answered], tools } },
    {
      when: "a tool call is left unanswered",
      input: { messages: [user, called, { role: "user", content: "And?" }], tools },
    },
    { when: "the history ends on an unanswered call", input: { messages: [user, called], tools } },
    {
      when: "two tool calls share an id",
      input: { messages: [user, called, answered, called, answered], tools },
    },
    {
      when: "an assistant tool call is malformed",
      input: {
        messages: [user, { role: "assistant", content: "", toolCalls: [{ id: "", name: "getIssue" }] }],
        tools,
      },
    },
    { when: "the provider state is not a string", input: { messages: [user, { ...called, providerState: 4 }, answered], tools } },
    { when: "tools is not a record", input: { messages: [user], tools: [GET_ISSUE] } },
    { when: "a tool name has a space", input: { messages: [user], tools: { "get issue": GET_ISSUE } } },
    { when: "a tool name is too long", input: { messages: [user], tools: { ["a".repeat(65)]: GET_ISSUE } } },
    {
      when: "there are too many tools",
      input: {
        messages: [user],
        tools: Object.fromEntries(
          Array.from({ length: AI_TOOL_LIMIT + 1 }, (_, index) => [`t${String(index)}`, GET_ISSUE]),
        ),
      },
    },
    { when: "a tool has no description", input: { messages: [user], tools: { a: { ...GET_ISSUE, description: "" } } } },
    {
      when: "a tool's parameters are not an object schema",
      input: { messages: [user], tools: { a: { ...GET_ISSUE, parameters: { type: "string" } } } },
    },
    { when: "a tool carries an unknown key", input: { messages: [user], tools: { a: { ...GET_ISSUE, strict: true } } } },
    { when: "toolChoice comes without tools", input: { messages: [user], toolChoice: "auto" } },
    { when: "toolChoice is unknown", input: { messages: [user], tools, toolChoice: "none" } },
    { when: "toolChoice names an absent tool", input: { messages: [user], tools, toolChoice: { name: "b" } } },
    {
      when: "the history holds too many messages",
      input: { messages: Array.from({ length: AI_CONVERSATION_MESSAGE_LIMIT + 1 }, () => user) },
    },
    {
      when: "the history's text is past the bounded length",
      input: { messages: [{ role: "user", content: "x".repeat(AI_CONVERSATION_LIMIT_CHARACTERS + 1) }] },
    },
  ])("refuses the call before reaching a model when $when", async ({ input }) => {
    const generateText = generating("never");
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
    });

    await expect(integration.generateText(input as never)).rejects.toMatchObject({
      code: "INVALID_AI_REQUEST",
      retryable: false,
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("treats a key holding undefined as absent", async () => {
    const generateText = generating("Hello.");
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
    });

    await integration.generateText({
      messages: [user],
      tools: undefined,
      prompt: undefined,
    } as never);

    expect(generateText).toHaveBeenCalledWith({ messages: [user] }, {});
  });
});

describe("the default port", () => {
  it("refuses image generation without a host-supplied port", async () => {
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText: generating("unused"),
    });

    await expect(
      integration.generateImage({ prompt: "Illustrate this." }),
    ).rejects.toMatchObject({
      code: "AI_GENERATION_UNAVAILABLE",
      retryable: false,
    });
  });

  it("refuses text generation without a host-supplied port", async () => {
    const integration = createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText: unavailableAiGenerateText(),
    });

    await expect(
      integration.generateText({ prompt: "Summarize." }),
    ).rejects.toMatchObject({
      code: "AI_GENERATION_UNAVAILABLE",
      retryable: false,
    });
  });

  it("is what an environment-composed runtime gets", async () => {
    const integrations = createWorkflowIntegrationsFromEnv({
      fetch: async () => new Response("{}"),
    });

    await expect(
      integrations.ai.generateText({ prompt: "Summarize." }),
    ).rejects.toMatchObject({ code: "AI_GENERATION_UNAVAILABLE" });
  });

  it("is replaced by an injected port on a fixture surface", async () => {
    const integrations = createWorkflowIntegrationsFromEnv({
      fetch: async () => new Response("{}"),
      generateText: generating("fixture text"),
    });

    await expect(
      integrations.ai.generateText({ prompt: "Summarize." }),
    ).resolves.toEqual({ text: "fixture text" });
  });

  it("accepts an injected image generation port on a fixture surface", async () => {
    const integrations = createWorkflowIntegrationsFromEnv({
      fetch: async () => new Response("{}"),
      generateImage: generatingImage(
        "https://images.example.test/generated.png",
      ),
    });

    await expect(
      integrations.ai.generateImage({ prompt: "Illustrate this." }),
    ).resolves.toEqual({
      imageUrl: "https://images.example.test/generated.png",
    });
  });
});
