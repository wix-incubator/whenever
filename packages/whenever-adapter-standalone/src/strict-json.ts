export function strictJsonSnapshot(
  value: unknown,
  limits: StrictJsonLimits = UNLIMITED,
): { readonly value: unknown } | undefined {
  try {
    return {
      value: snapshot(
        value,
        new Set(),
        { nodes: limits.maxNodes },
        limits.dropUndefinedProperties === true,
      ),
    };
  } catch {
    return undefined;
  }
}

// Undefined where the walk refused something it cannot address — a throwing getter, or nesting past
// the stack — so the caller states the rule alone rather than pointing at a guess.
export function strictJsonViolation(
  value: unknown,
  root: string,
  limits: StrictJsonLimits = UNLIMITED,
): string | undefined {
  try {
    snapshot(
      value,
      new Set(),
      { nodes: limits.maxNodes },
      limits.dropUndefinedProperties === true,
    );
    return undefined;
  } catch (error) {
    return error instanceof StrictJsonViolation
      ? error.describe(root)
      : undefined;
  }
}

export interface StrictJsonLimits {
  readonly maxNodes: number;
  readonly dropUndefinedProperties?: boolean;
}

const UNLIMITED: StrictJsonLimits = { maxNodes: Number.POSITIVE_INFINITY };

interface Budget {
  nodes: number;
}

// Assemble the diagnostic path while unwinding a failure so successful validation avoids it.
class StrictJsonViolation extends Error {
  private readonly segments: string[] = [];

  public constructor(private readonly reason: string) {
    super(reason);
    this.name = "StrictJsonViolation";
  }

  public within(segment: string): StrictJsonViolation {
    this.segments.unshift(segment);
    return this;
  }

  public describe(root: string): string {
    return `${root}${this.segments.join("")} ${this.reason}`;
  }
}

function located(error: unknown, segment: string): unknown {
  return error instanceof StrictJsonViolation ? error.within(segment) : error;
}

function snapshot(
  value: unknown,
  ancestors: Set<object>,
  budget: Budget,
  dropUndefinedProperties = false,
): unknown {
  budget.nodes -= 1;
  if (budget.nodes < 0) {
    throw new StrictJsonViolation("exceeds the strict JSON budget");
  }
  if (value === undefined) throw new StrictJsonViolation("is undefined");
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new StrictJsonViolation(`is a ${typeof value}`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new StrictJsonViolation(`is ${String(value)}`);
  }
  // JSON has one zero, so keeping -0 would leave the snapshot holding a value the
  // encoded request does not carry.
  if (typeof value === "number") return value === 0 ? 0 : value;
  if (value === null || typeof value !== "object") return value;
  if (!Array.isArray(value) && !isJsonRecord(value)) {
    throw new StrictJsonViolation("is not strict JSON");
  }
  if (ancestors.has(value)) throw new StrictJsonViolation("is cyclic");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copied: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        // A hole is skipped by map and forEach but serializes as null, so it has
        // to be refused explicitly rather than copied over.
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new StrictJsonViolation("is a hole").within(`[${String(index)}]`);
        }
        try {
          copied.push(snapshot(value[index], ancestors, budget));
        } catch (error) {
          throw located(error, `[${String(index)}]`);
        }
      }
      return copied;
    }
    const copied: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined && dropUndefinedProperties) continue;
      try {
        define(copied, key, snapshot(entry, ancestors, budget));
      } catch (error) {
        throw located(error, `.${key}`);
      }
    }
    return copied;
  } finally {
    ancestors.delete(value);
  }
}

// Plain assignment would route the key "__proto__" through the inherited setter,
// which changes the copy's prototype and loses the property JSON would have kept.
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
