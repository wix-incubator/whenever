// Self-contained lint configuration for this package.
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  env: {
    node: true,
    es2022: true,
  },
  settings: {
    "import/resolver": { typescript: true, node: true },
    "import/parsers": { "@typescript-eslint/parser": [".ts", ".cts", ".mts", ".tsx"] },
  },
  plugins: ["@typescript-eslint", "simple-import-sort", "unused-imports", "import"],
  rules: {
    "@typescript-eslint/consistent-type-imports": "error",
    "simple-import-sort/imports": "error",
    "simple-import-sort/exports": "error",
    "unused-imports/no-unused-imports": "error",
    "import/no-cycle": ["error", { maxDepth: Infinity }],
  },
};
