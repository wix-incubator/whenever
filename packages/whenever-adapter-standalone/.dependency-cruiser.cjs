// The SDK is the only workspace this package may import.
const ownCode = { pathNot: "^\\.\\." };

module.exports = {
  forbidden: [
    {
      name: "no-workspace-import",
      severity: "error",
      comment:
        "@wix/whenever-adapter-standalone is published next to the SDK and imports no other whenever package.",
      from: ownCode,
      to: { path: "(?:^\\.\\./|^\\.\\./.+/)whenever-", pathNot: "(?:^\\.\\./|^\\.\\./.+/)whenever-workflow-sdk/" },
    },
    {
      name: "no-unresolvable-sdk-import",
      severity: "error",
      comment:
        "The SDK resolves through its dist, so an unbuilt SDK would make no-workspace-import pass while seeing nothing.",
      from: {},
      to: { couldNotResolve: true, path: "^@wix/whenever-" },
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
