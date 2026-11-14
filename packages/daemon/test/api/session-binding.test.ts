import type { EventBody, NodeEvent } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { verifyNodeToken } from "../../src/api/node-auth.js";
import { createSessionBindings } from "../../src/api/session-binding.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";

// session_id → ノードの記録と、ノードの資格情報の確かめ。
let n = 0;
const open = (store = createMemoryStore()) => {
  const opened = EventLog.open(store.open(), { clock: () => "2026-11-11T00:00:00Z" });
  if (!opened.ok) throw new Error(opened.error.code);
  return opened.value;
};
const seed = (log: ReturnType<typeof open>) => {
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
};

describe("createSessionBindings", () => {
  it("bound で session_id を記録し、lookupNodeBySession でノードと作業ツリーを引ける（トークンは返さない）", async () => {
    const log = open();
    seed(log);
    const b = createSessionBindings({ log, cwdOf: async (id) => `/w/trees/${id}` });
    expect(await b.lookupNodeBySession("sess-1")).toBeUndefined();
    expect(b.bound("a", { sessionId: "sess-1", cwd: "/w/trees/a" })).toBe(true);
    const hit = await b.lookupNodeBySession("sess-1");
    expect(hit).toEqual({ nodeId: "a", worktree: "/w/trees/a", trust: "sessionIdOnly" });
    expect(Object.keys(hit ?? {})).not.toContain("token");
    expect(log.state().nodes.find((x) => x.id === "a")?.sessionId).toBe("sess-1");
  });

  it("記録はイベントログに残り、開き直しても引ける", async () => {
    const store = createMemoryStore();
    const log = open(store);
    seed(log);
    createSessionBindings({ log, cwdOf: async () => undefined }).bound("a", {
      sessionId: "sess-2",
    });
    const again = open(store);
    const hit = await createSessionBindings({
      log: again,
      cwdOf: async () => "/w/trees/a",
    }).lookupNodeBySession("sess-2");
    expect(hit?.nodeId).toBe("a");
  });

  it("session_id がない・形が違うときは記録しない。onBound の入口は呼ぶ", async () => {
    const log = open();
    seed(log);
    const b = createSessionBindings({ log, cwdOf: async () => undefined });
    const seen: string[] = [];
    const off = b.onBound((id, info) => seen.push(`${id}:${info.cwd ?? ""}`));
    b.bound("a", { cwd: "/w/trees/a" });
    b.bound("a", { sessionId: "bad id!" });
    expect(log.state().nodes.find((x) => x.id === "a")?.sessionId).toBeUndefined();
    expect(seen).toEqual(["a:/w/trees/a", "a:"]);
    off();
    b.bound("a", {});
    expect(seen).toHaveLength(2);
  });

  it("同じ session_id が 2 つのノードに結ばれていたら、引かない", async () => {
    const log = open();
    seed(log);
    log.append({
      requestId: "seed-b",
      actor: { system: true },
      body: {
        type: "node.created",
        payload: { nodeId: "b", role: "implement", parentId: "root", dependsOn: [] },
      },
    });
    const b = createSessionBindings({ log, cwdOf: async () => undefined });
    b.bound("a", { sessionId: "same" });
    b.bound("b", { sessionId: "same" });
    expect(await b.lookupNodeBySession("same")).toBeUndefined();
  });
});

describe("verifyNodeToken", () => {
  it("有効なトークンなら主体を、無効・ヘッダなしなら undefined を返す", () => {
    const log = open();
    seed(log);
    const credentials = createCredentialStore({
      humanToken: "human-token-human-token-human-token-1234",
    });
    const token = credentials.issueNodeToken("a", "child");
    const deps = { credentials, getState: () => log.state() };
    expect(verifyNodeToken(deps, `Bearer ${token}`)).toEqual({ role: "child", nodeId: "a" });
    expect(verifyNodeToken(deps, "Bearer nope-nope-nope-nope")).toBeUndefined();
    expect(verifyNodeToken(deps, undefined)).toBeUndefined();
  });
});

describe("lookup の trust の印・重なり・終わったノード", () => {
  it("lookup の結果は trust: sessionIdOnly を持つ。conflicts はほかの生きているノードだけを数える。終わったノードは引かない", async () => {
    const log = open();
    seed(log);
    const b = createSessionBindings({ log, cwdOf: async () => "/w/trees/a" });
    b.bound("a", { sessionId: "s-1" });
    expect((await b.lookupNodeBySession("s-1"))?.trust).toBe("sessionIdOnly");
    expect(b.conflicts("a", "s-1")).toBe(false);
    expect(b.conflicts("other", "s-1")).toBe(true);
    const ev = (event: NodeEvent) =>
      log.append({
        requestId: `e-${++n}`,
        actor: { system: true },
        body: { type: "node.stateChanged", payload: { nodeId: "a", event } },
      });
    ev({ type: "stop", mode: "immediate" });
    ev({ type: "confirmStopped" });
    expect(log.state().nodes.find((x) => x.id === "a")?.state).toBe("stopped");
    expect(await b.lookupNodeBySession("s-1")).toBeUndefined();
    expect(b.conflicts("other", "s-1")).toBe(false);
  });
});
