import {
  defineWorkflow,
  defineStep,
  daily,
  manual,
  NonRetryableError,
  RetryableError,
  type WorkflowContext,
  type WorkflowManifest,
} from "@wix/whenever-workflow-sdk";

export const manifest: WorkflowManifest = {
  name: "daily-rate-report",
  triggers: [
    daily({ key: "morning-report", at: "09:00", tz: "Europe/Vilnius" }),
    manual({ key: "rerun" }),
  ],
};

// Supplied by the user, not invented: a scheduled run gets no input.
const rateUrl = "https://api.example.com/rates/eur";

// Report its shape and never its values: a payload copied into a persisted failure carries
// whatever the server put in it.
function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string(${String(value.length)})`;
  if (Array.isArray(value)) {
    return depth > 2 || value.length === 0
      ? "array"
      : `array of ${shapeOf(value[0], depth + 1)}`;
  }
  if (typeof value !== "object") return typeof value;
  if (depth > 2) return "object";
  const fields = Object.entries(value)
    .slice(0, 12)
    .map(([name, item]) => `${name}: ${shapeOf(item, depth + 1)}`);
  return `{ ${fields.join(", ")} }`;
}

// Every http.* result types body as unknown, so a guard is the only way in.
function isRate(body: unknown): body is { rate: number } {
  return (
    typeof body === "object" &&
    body !== null &&
    "rate" in body &&
    typeof body.rate === "number"
  );
}

// An mcp.* result types structuredContent and content as unknown for the same reason.
function isFiledCount(value: unknown): value is { filed: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "filed" in value &&
    typeof value.filed === "number"
  );
}

// Most servers declare no output schema, leaving structuredContent absent and the answer in the
// first text block of content, as JSON. Read the structured half when there, else fall back.
function filedCount(result: { structuredContent: unknown; content: unknown }): number {
  if (isFiledCount(result.structuredContent)) return result.structuredContent.filed;
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.find(
    (block): block is { text: string } =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string",
  );
  if (text === undefined) {
    throw new NonRetryableError("the audit tool answered with no readable content", {
      detail: shapeOf(result.content),
    });
  }
  let reported: unknown;
  try {
    reported = JSON.parse(text.text);
  } catch {
    throw new NonRetryableError("the audit tool answered with text that is not JSON", {
      detail: shapeOf(text.text),
    });
  }
  if (!isFiledCount(reported)) {
    throw new NonRetryableError("the audit tool returned no filed count", {
      detail: shapeOf(reported),
    });
  }
  return reported.filed;
}

export const readRate = defineStep("read-rate", async (ctx: WorkflowContext) => {
  const response = await ctx.integrations.http.get({ url: rateUrl });

  if (!isRate(response.body)) {
    throw new NonRetryableError("the rate endpoint returned an unexpected body", {
      detail: shapeOf(response.body),
    });
  }

  const { rate } = response.body;
  ctx.log("read rate", { rate });
  return rate;
});

export const countFiledReports = defineStep(
  "count-filed-reports",
  async (ctx: WorkflowContext) => {
    const audit = await ctx.integrations.mcp.read({
      url: ctx.secrets.AUDIT_MCP_URL,
      toolName: "count_filed_reports",
      toolProps: { window: "today" },
      headers: { Authorization: `Bearer ${ctx.secrets.AUDIT_MCP_TOKEN}` },
    });
    return filedCount(audit);
  },
);

export const fileReport = defineStep(
  "file-report",
  async (ctx: WorkflowContext, rate: number, filed: number) => {
    const report = await ctx.integrations.http.post({
      url: ctx.secrets.REPORT_ENDPOINT,
      headers: { Authorization: `Bearer ${ctx.secrets.REPORT_API_KEY}` },
      body: {
        rate,
        filed,
        observedAt: ctx.now(),
        nonce: Math.floor(ctx.random() * 100),
      },
    });

    if (typeof report.body !== "object" || report.body === null) {
      throw new RetryableError("the report endpoint returned no receipt", {
        retryAfterMs: 60_000,
        detail: shapeOf(report.body),
      });
    }
    if (!("id" in report.body) || typeof report.body.id !== "string") {
      throw new NonRetryableError("the report receipt carries no id", {
        detail: shapeOf(report.body),
      });
    }

    return report.body.id;
  },
);

export default defineWorkflow<void, { rate: number; reportId: string }>(
  async (ctx) => {
    const rate = await readRate(ctx);
    const filed = await countFiledReports(ctx);
    const reportId = await fileReport(ctx, rate, filed);
    return { rate, reportId };
  },
);
