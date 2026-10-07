import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    // Stryker's sandbox is a copy of this package and has to live inside it to resolve vitest, so
    // without this a run left behind makes every spec discoverable twice.
    exclude: ["**/node_modules/**", "**/dist/**", ".stryker-tmp/**"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
      tsconfig: "./tsconfig.typecheck.json",
    },
  },
});
