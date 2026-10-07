import { describe, expect, it } from "vitest";

import { strictJsonSnapshot, strictJsonViolation } from "../src/strict-json";

describe("strict JSON snapshots", () => {
  it("holds exactly the value JSON encodes, so evidence and transport agree", () => {
    const original = {
      keep: 1,
      balance: -0,
      nested: { rows: [1, 2], flag: false, missing: null },
      [Symbol("unencodable")]: "dropped by JSON too",
    };

    const snapshot = strictJsonSnapshot(original);

    expect(snapshot?.value).toEqual(JSON.parse(JSON.stringify(original)));
    expect(JSON.stringify(snapshot?.value)).toBe(JSON.stringify(original));
    expect(
      Object.is((snapshot?.value as { balance: number }).balance, 0),
    ).toBe(true);
  });

  it("refuses a structure past its budget while walking it, not after copying it", () => {
    expect(strictJsonSnapshot([1, 2, 3], { maxNodes: 4 })).toEqual({
      value: [1, 2, 3],
    });
    expect(strictJsonSnapshot([1, 2, 3, 4], { maxNodes: 4 })).toBeUndefined();
  });

  it("drops a top-level undefined inside the walk it charges for", () => {
    expect(
      strictJsonSnapshot(
        { keep: 1, absent: undefined },
        { maxNodes: 2, dropUndefinedProperties: true },
      ),
    ).toEqual({ value: { keep: 1 } });
    expect(
      strictJsonSnapshot({ keep: 1, absent: undefined }, { maxNodes: 2 }),
    ).toBeUndefined();
    expect(
      strictJsonSnapshot(
        { nested: { absent: undefined } },
        { maxNodes: 10, dropUndefinedProperties: true },
      ),
    ).toBeUndefined();
  });

  it("copies an ordinary class instance as the properties JSON would carry", () => {
    class Point {
      constructor(
        readonly x: number,
        readonly y: number,
      ) {}
    }

    expect(strictJsonSnapshot(new Point(1, 2))).toEqual({
      value: { x: 1, y: 2 },
    });
  });

  it("does not bound nesting, which JSON carries unchanged", () => {
    let value: unknown = 1;
    for (let level = 0; level < 200; level += 1) value = { level: value };

    expect(JSON.stringify(strictJsonSnapshot(value, { maxNodes: 1_000 })?.value)).toBe(
      JSON.stringify(value),
    );
  });
});

describe("strict JSON violations", () => {
  it("names the path of the value the walk refused", () => {
    expect(strictJsonViolation({ topic: undefined, message: "hi" }, "body")).toBe(
      "body.topic is undefined",
    );
    expect(strictJsonViolation({ a: { b: [1, () => 1] } }, "body")).toBe(
      "body.a.b[1] is a function",
    );
    expect(strictJsonViolation({ ratio: Number.NaN }, "body")).toBe(
      "body.ratio is NaN",
    );
    expect(strictJsonViolation(undefined, "toolProps")).toBe(
      "toolProps is undefined",
    );
  });

  it("names a cycle by the path that closes it", () => {
    const body: Record<string, unknown> = { name: "loop" };
    body.self = body;

    expect(strictJsonViolation(body, "body")).toBe("body.self is cyclic");
  });

  it("names where a budget ran out rather than only that it did", () => {
    expect(strictJsonViolation({ a: [1, 2, 3] }, "body", { maxNodes: 3 })).toBe(
      "body.a[1] exceeds the strict JSON budget",
    );
  });

  it("names a hole by its own index, not the index twice", () => {
    const holed = [1, 2, 3];
    delete holed[1];

    expect(strictJsonViolation({ items: holed }, "body")).toBe(
      "body.items[1] is a hole",
    );
  });

  it("reports nothing when the walk refused something it cannot address", () => {
    const throwing = {
      get token(): unknown {
        throw new Error("the getter refused");
      },
    };

    expect(strictJsonSnapshot(throwing)).toBeUndefined();
    expect(strictJsonViolation(throwing, "body")).toBeUndefined();
  });

  it("reports nothing for a value the snapshot accepts", () => {
    expect(strictJsonViolation({ ok: 1, nested: [1, null] }, "body")).toBeUndefined();
    expect(
      strictJsonViolation({ absent: undefined }, "body", {
        maxNodes: 10,
        dropUndefinedProperties: true,
      }),
    ).toBeUndefined();
  });
});
