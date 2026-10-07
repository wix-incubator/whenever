// Self-contained, not built from depcruise/architecture.cjs, so the boundary holds once this package
// leaves the monorepo: it imports no other workspace.
const ownCode = { pathNot: "^\\.\\." };

module.exports = {
  forbidden: [
    {
      name: "no-workspace-import",
      severity: "error",
      comment:
        "@wix/whenever-workflow-sdk is published on its own and imports no other whenever package.",
      from: ownCode,
      to: { path: "(?:^\\.\\./|^\\.\\./.+/)whenever-" },
    },
    {
      name: "no-runtime-cycle",
      severity: "error",
      comment:
        "A cycle means neither module owns the shared concern. Type-only cycles are erased at run time and are ignored.",
      from: ownCode,
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
  ],
  options: {
    tsPreCompilationDeps: "specify",
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "(^|/)(node_modules|dist)(/|$)" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".d.ts"],
    },
  },
};
