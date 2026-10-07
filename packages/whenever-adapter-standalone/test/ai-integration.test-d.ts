import { describe, expectTypeOf, it } from "vitest";

import type {
  AiGenerateImagePort,
  AiGenerateTextPort,
  AiGenerationCall,
  AiIntegrationOptions,
} from "../src/ai-integration";

describe("AI integration composition", () => {
  it("requires an image generation port", () => {
    type WithoutImagePort = Omit<AiIntegrationOptions, "generateImage">;

    expectTypeOf<
      WithoutImagePort extends AiIntegrationOptions ? true : false
    >().toEqualTypeOf<false>();
  });

  it("shares a generation call contract across AI operations", () => {
    expectTypeOf<AiGenerateImagePort>()
      .parameter(1)
      .toEqualTypeOf<AiGenerationCall>();
    expectTypeOf<AiGenerateTextPort>()
      .parameter(1)
      .toEqualTypeOf<AiGenerationCall>();
  });
});
