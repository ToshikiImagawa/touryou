import type { EventBody, NodeEvent } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createBindCodes } from "../../../src/api/bind.js";
import { createBindHandlers } from "../../../src/api/handlers/bind-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

// node.bindCode の CLI の木の文面。
let n = 0;
const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => "2026-11-11T00:00:00Z" });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(r.error.code);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  ev("root", { type: "start" });
  add({
    type: "node.created",
    payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
  });
  ev("a", { type: "start" });
  add({
    type: "node.created",
    payload: { nodeId: "p", role: "implement", parentId: "root", dependsOn: [] },
  });
  const now = Date.parse("2026-11-11T00:00:00Z");
  const bind = createBindCodes({ clock: () => now });
  const h = createBindHandlers({ log, bind, cli: true, baseUrl: () => "http://127.0.0.1:7777" });
  const call = (nodeId: string) =>
    h["node.bindCode"]({
      requestId: `q-${++n}`,
      operation: "node.bindCode",
      role: "integrator",
      caller: { nodeId: "root" },
      params: { nodeId },
    } as unknown as HandlerRequest<"node.bindCode">);
  return { bind, call, events: () => log.state() };
};
const codeOf = (text: string): string => {
  const m = /bindCode: ([0-9A-Z-]+)/.exec(text);
  if (!m) throw new Error("no code");
  return m[1] as string;
};

describe("node.bindCode（CLI の子）", () => {
  it("一度きりのコードと、child_bind を呼ぶ手順を返す。期限つき。コードは記録に入らない", () => {
    const r = rig();
    const res = r.call("a");
    if (!res.ok) throw new Error(res.error.code);
    expect(res.value.instruction).toContain("child_bind");
    expect(res.value.instruction).toContain("nodeId: a");
    expect(res.value.expiresAt).toBe("2026-11-11T00:10:00.000Z");
    const code = codeOf(res.value.instruction);
    expect(JSON.stringify(r.events())).not.toContain(code.replaceAll("-", ""));
    expect(r.bind.redeem("a", code).ok).toBe(true);
    expect(r.bind.redeem("a", code).ok).toBe(false); // 再使用
  });

  it("出し直すと、前のコードは無効になる", () => {
    const r = rig();
    const first = r.call("a");
    const second = r.call("a");
    if (!first.ok || !second.ok) throw new Error("failed");
    expect(r.bind.redeem("a", codeOf(first.value.instruction)).ok).toBe(false);
    expect(r.bind.redeem("a", codeOf(second.value.instruction)).ok).toBe(true);
  });

  it("起動前（pending）のノードは notActive", () => {
    const r = rig();
    const p = r.call("p");
    expect(p.ok ? "" : p.error.code).toBe("notActive");
  });
});

describe("G: Desktop の木の node.bindCode", () => {
  it("cli の旗があっても、Desktop のアダプタがあれば Desktop の文面を返す", () => {
    const opened = EventLog.open(createMemoryStore().open(), {
      clock: () => "2026-11-11T00:00:00Z",
    });
    if (!opened.ok) throw new Error(opened.error.code);
    const log = opened.value;
    const add = (body: EventBody) =>
      log.append({ requestId: `g-${++n}`, actor: { system: true }, body });
    add({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
    add({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } });
    const h = createBindHandlers({
      log,
      bind: createBindCodes(),
      cli: true,
      desktop: { instructionOf: () => "あなたのノード ID: a" },
      baseUrl: () => "http://127.0.0.1:7777",
      touryouCommand: ["node", "/opt/touryou/bin.js"],
      prepareDrawer: () => "/d",
    });
    const r = h["node.bindCode"]({
      requestId: "q",
      operation: "node.bindCode",
      role: "human",
      params: { nodeId: "a" },
    } as unknown as HandlerRequest<"node.bindCode">);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value.instruction).toContain("touryou child");
    expect(r.value.instruction).not.toContain("child_bind");
  });
});
