import { NODE_STATES } from "@touryou/core";
import { describe, expect, it } from "vitest";

describe("@touryou/core への依存", () => {
  it("workspace の core の公開名を参照できる（A-001: 依存方向は core へ）", () => {
    expect(NODE_STATES).toContain("pending");
  });
});
