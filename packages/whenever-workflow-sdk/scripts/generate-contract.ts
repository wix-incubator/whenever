import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ParsedReExports {
  symbols: string[];
  modules: string[];
}

interface WorkflowSdkContract {
  version: string;
  symbols: string[];
  integrationSymbols: string[];
  declarations: string;
  integrationDeclarations: string;
  markdown: string;
}

const INTEGRATIONS_MODULE = "integrations";

function isIntegrationModule(moduleName: string): boolean {
  return moduleName === INTEGRATIONS_MODULE;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const distDir = resolve(packageDir, "dist");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function parseReExports(indexDts: string): ParsedReExports {
  const symbols: string[] = [];
  const modules = new Set<string>();
  const seen = new Set<string>();
  const pattern = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']\.\/([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(indexDts)) !== null) {
    modules.add(match[2].replace(/\.js$/, ""));
    for (const entry of match[1].split(",")) {
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !seen.has(name)) {
        seen.add(name);
        symbols.push(name);
      }
    }
  }
  return { symbols, modules: [...modules] };
}

function cleanDeclaration(text: string): string {
  return text
    .split("\n")
    .filter((line: string) => !/^\s*import\s.+from\s+["']\.[^"']*["'];?\s*$/.test(line))
    .filter((line: string) => !/^\s*\/\/#\s*sourceMappingURL=/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseDeclaredNames(declaration: string): string[] {
  const names = new Set<string>();
  const pattern =
    /export\s+(?:declare\s+)?(?:interface|type|const|function|class)\s+([A-Za-z0-9_$]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(declaration)) !== null) {
    names.add(match[1]);
  }
  return [...names];
}

function parseProviderKeys(declaration: string): string[] {
  const body = /export\s+interface\s+WorkflowIntegrations\s*\{([^}]*)\}/.exec(
    declaration,
  );
  if (body == null) return [];
  return [...body[1].matchAll(/^\s*([A-Za-z0-9_$]+)\s*:/gm)].map(
    (match) => match[1],
  );
}

const indexDts = read(resolve(distDir, "index.d.ts"));
const { symbols, modules } = parseReExports(indexDts);

const integrationsDts = read(resolve(distDir, `${INTEGRATIONS_MODULE}.d.ts`));
const integrationSymbols = parseDeclaredNames(integrationsDts);
const integrationDeclarations = cleanDeclaration(integrationsDts);
const providerKeys = parseProviderKeys(integrationsDts);
if (!providerKeys.includes("http")) {
  throw new Error(
    "WorkflowIntegrations no longer declares http, so the contract would ship no transport at all",
  );
}

const declarations = modules
  .filter((moduleName: string) => !isIntegrationModule(moduleName))
  .map((moduleName: string) =>
    cleanDeclaration(read(resolve(distDir, `${moduleName}.d.ts`))),
  )
  .filter((block: string) => block.length > 0)
  .join("\n\n");

const packageJson = JSON.parse(read(resolve(packageDir, "package.json"))) as {
  version: string;
};
const version: string = packageJson.version;

const canonicalExample = read(
  resolve(packageDir, "examples", "canonical.workflow.ts"),
).trim();

const markdown = `# Whenever workflow authoring contract (SDK v${version})

Generated from the SDK's type declarations — do not hand-edit.

A workflow module exports a named \`manifest\` (a \`WorkflowManifest\`), one or more named \`defineStep\` functions implementing observable units of work, and a default \`defineWorkflow\` run descriptor that calls those steps.

## Authoring surface (from \`@wix/whenever-workflow-sdk\` type declarations)

\`\`\`ts
${declarations}
\`\`\`

## Side effects (\`ctx.integrations\`)

\`ctx.integrations\` is a \`WorkflowIntegrations\` port. The SDK itself declares ${providerKeys.join(", ")}. \`http\` and \`mcp\` take an address the author supplies; \`postgres\` and \`ai\` use host-supplied ports.

Every other provider operation comes from a binding supplied by the host. Its input and result types are declared as a \`WorkflowIntegrations\` augmentation, which is what makes \`ctx.integrations.<toolkit>.<operation>\` compile. An operation that has not been bound in this workspace neither typechecks nor runs, so bind it before writing the call — and take the call and the types from what the bind returned rather than restating them.

## Canonical example

\`\`\`ts
${canonicalExample}
\`\`\`

## Authoring invariants

- Determinism: read time and randomness only through \`ctx.now()\` and \`ctx.random()\`; never call \`Date.now()\`, \`Math.random()\`, or other ambient sources.
- Credentials: consume side effects through \`ctx.integrations\`; never read \`process.env\` or credential values from a workflow.
- Structure: workflow code uses \`export const name = defineStep("Human name", async (ctx: WorkflowContext, ...args) => ...)\`. Keep helpers unexported; \`defineWorkflow\` calls exported steps with prior results as arguments.
- Observability: \`defineStep\` records start, completion, timing, and failure. Use \`ctx.log(message, data?)\` for annotations; never log secrets or credentials.
- Outcome: return a value that names what the workflow did, and declare it as \`defineWorkflow<TInput, TOutput>\` — with one type argument \`TOutput\` is \`void\` and returning a value will not compile. A workflow that returns nothing cannot be proven to have succeeded from its output. The host defines how it records outcomes and activates triggers; returning a value alone does not establish host-side activation.
- A TypeScript type existing does NOT prove the runtime can execute it. This section is the authoring surface only; the host must supply the corresponding implementation and credentials before a run can use it.
`;

const contract: WorkflowSdkContract = {
  version,
  symbols,
  integrationSymbols,
  declarations,
  integrationDeclarations,
  markdown,
};

const contractJs = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKFLOW_SDK_CONTRACT = void 0;
exports.WORKFLOW_SDK_CONTRACT = ${JSON.stringify(contract, null, 2)};
`;

const contractDts = `export interface WorkflowSdkContract {
    version: string;
    symbols: string[];
    integrationSymbols: string[];
    declarations: string;
    integrationDeclarations: string;
    markdown: string;
}
export declare const WORKFLOW_SDK_CONTRACT: WorkflowSdkContract;
`;

writeFileSync(resolve(distDir, "contract.js"), contractJs);
writeFileSync(resolve(distDir, "contract.d.ts"), contractDts);
writeFileSync(resolve(distDir, "contract.md"), markdown);

process.stdout.write(
  `generate-contract: wrote dist/contract.{js,d.ts,md} (v${version}, ${symbols.length} symbols)\n`,
);
