import { describe, expect, it } from "vitest";
import { foldEvents, type OrchEvent } from "../src/events.js";

/** 記録の行為者の `trust`（トークンなし・session_id で引いた報告の印）の往復。 */
const ev = (seq: number, actor: unknown, body: unknown): OrchEvent =>
  ({
    seq,
    at: "2026-11-11T00:00:00Z",
    requestId: `r${seq}`,
    actor,
    ...(body as object),
  }) as OrchEvent;
const created = {
  type: "node.created",
  payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
};
const inbox = (id: string) => ({
  type: "inbox.added",
  payload: { id, kind: "info", nodeId: "root", summary: "x" },
});

describe("Actor の trust", () => {
  it("旧い記録（trust なし）は、いままでどおり読める", () => {
    const r = foldEvents([ev(1, { system: true }, created), ev(2, { system: true }, inbox("i1"))]);
    expect(r.ok).toBe(true);
  });

  it("trust: sessionIdOnly つきの記録を読める", () => {
    const r = foldEvents([
      ev(1, { system: true }, created),
      ev(2, { system: true, trust: "sessionIdOnly" }, inbox("i2")),
    ]);
    expect(r.ok).toBe(true);
  });

  it("知らない trust の値は、行為者として認めない（記録を拒む）", () => {
    const r = foldEvents([
      ev(1, { system: true }, created),
      ev(2, { system: true, trust: "token" }, inbox("i3")),
    ]);
    expect(r.ok).toBe(false);
  });
});
