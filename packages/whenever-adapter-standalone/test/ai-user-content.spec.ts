import type { AiIntegration, AiUserImagePart } from "@wix/whenever-workflow-sdk";
import { describe, expect, it, type Mock, vi } from "vitest";

import {
  AI_IMAGE_LIMIT,
  AI_IMAGE_URL_LIMIT_CHARACTERS,
  type AiGenerateTextPort,
  createAiIntegration,
  unavailableAiGenerateImage,
  unavailableAiGenerateVideo,
} from "../src/ai-integration";

const SCREENSHOT: AiUserImagePart = {
  type: "image",
  url: "https://static.example.com/media/screenshot.png",
  mediaType: "image/png",
};
const ASKED = { type: "text", text: "What does this screen say?" } as const;

function integrationAnswering(): {
  integration: AiIntegration;
  generateText: Mock<AiGenerateTextPort>;
} {
  const generateText = vi.fn<AiGenerateTextPort>(async () => ({ text: "It says hello." }));
  return {
    integration: createAiIntegration({
      generateImage: unavailableAiGenerateImage(),
      generateText,
      generateVideo: unavailableAiGenerateVideo(),
    }),
    generateText,
  };
}

function image(url: string): AiUserImagePart {
  return { ...SCREENSHOT, url };
}

describe("a prompt with images", () => {
  it("hands its text and image parts to the port in order", async () => {
    const { integration, generateText } = integrationAnswering();

    const result = await integration.generateText({ prompt: [ASKED, SCREENSHOT] });

    expect(result).toEqual({ text: "It says hello." });
    expect(generateText).toHaveBeenCalledWith({ prompt: [ASKED, SCREENSHOT] }, {});
  });

  it("hands the port an image URL in the form its host was checked in", async () => {
    const { integration, generateText } = integrationAnswering();

    await integration.generateText({
      prompt: [image("https://static.example.com\\@127.0.0.1/a.png")],
    });

    expect(generateText).toHaveBeenCalledWith(
      { prompt: [image("https://static.example.com/@127.0.0.1/a.png")] },
      {},
    );
  });
});

describe("a user message with images", () => {
  it("hands its text and image parts to the port in order", async () => {
    const { integration, generateText } = integrationAnswering();

    await integration.generateText({
      messages: [{ role: "user", content: [SCREENSHOT, ASKED] }],
    });

    expect(generateText).toHaveBeenCalledWith(
      { messages: [{ role: "user", content: [SCREENSHOT, ASKED] }] },
      {},
    );
  });

  const user = (content: unknown): unknown => ({ messages: [{ role: "user", content }] });

  it.each([
    { when: "the parts are empty", input: user([]) },
    { when: "a text part is blank", input: user([{ type: "text", text: " " }]) },
    { when: "a part has an unknown type", input: user([{ type: "audio", url: SCREENSHOT.url }]) },
    { when: "a part carries an unknown key", input: user([{ ...SCREENSHOT, detail: "high" }]) },
    { when: "an image has no format", input: user([{ type: "image", url: SCREENSHOT.url }]) },
    { when: "an image format is not offered", input: user([{ ...SCREENSHOT, mediaType: "image/tiff" }]) },
    { when: "an image URL is not a URL", input: user([image("screenshot.png")]) },
    { when: "an image URL is http:", input: user([image("http://static.example.com/a.png")]) },
    { when: "an image URL is a data: URL", input: user([image("data:image/png;base64,AAAA")]) },
    { when: "an image URL carries credentials", input: user([image("https://me:pw@static.example.com/a.png")]) },
    { when: "an image URL names a loopback host", input: user([image("https://127.0.0.1/a.png")]) },
    { when: "an image URL names an internal host", input: user([image("https://metadata.google.internal/a.png")]) },
    {
      when: "an image URL is past the bounded length",
      input: user([image(`https://static.example.com/${"a".repeat(AI_IMAGE_URL_LIMIT_CHARACTERS)}`)]),
    },
    {
      when: "the conversation holds more images than the bound",
      input: {
        messages: Array.from({ length: AI_IMAGE_LIMIT + 1 }, () => ({
          role: "user",
          content: [SCREENSHOT],
        })),
      },
    },
    { when: "an assistant message carries an image", input: { messages: [{ role: "assistant", content: [SCREENSHOT] }] } },
    { when: "a prompt holds an http: image", input: { prompt: [image("http://static.example.com/a.png")] } },
  ])("refuses the call before reaching a model when $when", async ({ input }) => {
    const { integration, generateText } = integrationAnswering();

    await expect(integration.generateText(input as never)).rejects.toMatchObject({
      code: "INVALID_AI_REQUEST",
      retryable: false,
    });
    expect(generateText).not.toHaveBeenCalled();
  });
});
