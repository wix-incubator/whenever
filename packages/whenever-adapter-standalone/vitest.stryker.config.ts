import { defineConfig } from "vitest/config";

// Stryker's vitest runner supports only the threads pool, and this package leaves the Vitest
// default. The type tests are off here for the same reason they cannot fail a mutant: a mutation
// changes a value, never a signature, so running them once per mutant only costs time.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    // Stryker's sandbox is a copy of this package and has to live inside it to resolve vitest, so
    // without this every spec is discovered twice.
    exclude: ["**/node_modules/**", "**/dist/**", ".stryker-tmp/**"],
    pool: "threads",
  },
});
