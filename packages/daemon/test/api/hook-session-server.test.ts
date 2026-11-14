import { type EventBody, foldEvents, type OrchEvent, type OrchState } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import type { HookDecider, HookRequest } from "../../src/api/hook.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";

/** トークンのないフック（session_id で引く）の窓口。 */
let n = 0;
const ev = (body: EventBody): OrchEvent =>
  ({
    seq: ++n,
    at: "2026-11-11T00:00:00Z",
    requestId: `r${n}`,
    actor: { system: true },
    ...body,
  }) as OrchEvent;
const state = (): OrchState => {
  const r = foldEvents([
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "z", role: "implement", parentId: "root", dependsOn: [] },
    }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};
const HUMAN = "human-token-human-token-human-token-1234";
const WT = "/wt/a";

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async (decide: HookDecider, stopReason?: string) => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  const s = state();
  // B の sessionBindings.lookupNodeBySession の代わり（session_id → ノード・作業ツリー・印）
  const bound = new Map<string, { nodeId: string; worktree: string }>();
  const table = {
    register: (sessionId: string, nodeId: string, worktree: string) =>
      void bound.set(sessionId, { nodeId, worktree }),
  };
  const notifications: { nodeId: string; h: HookRequest; via?: string }[] = [];
  const stops: string[] = [];
  server = createApiServer({
    credentials,
    getState: () => s,
    handlers: {},
    hook: decide,
    lookupSession: async (sessionId) => {
      const b = bound.get(sessionId);
      return b === undefined ? undefined : { ...b, trust: "sessionIdOnly" as const };
    },
    onHookNotification: (nodeId, h, via) =>
      void notifications.push({ nodeId, h, ...(via === undefined ? {} : { via }) }),
    onHookStop: (nodeId) => {
      stops.push(nodeId);
      return stopReason === undefined ? {} : { continueReason: stopReason };
    },
  });
  const { url } = await server.listen(0);
  return { url, table, notifications, stops, state: s };
};

const post = async (url: string, body: unknown) => {
  const res = await fetch(`${url}/v1/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const NONE = { status: 200, json: { ok: true, value: { decision: "none" } } };
const noneWith = (v: Record<string, string>) => ({
  status: 200,
  json: { ok: true, value: { decision: "none", ...v } },
});
const UNBOUND = noneWith({ noneReason: "unbound" });
const CWD = noneWith({ noneReason: "cwdMismatch" });

const calls: unknown[][] = [];
const policy: HookDecider = async (nodeId, toolName, _i, cwd, _t, trust) => {
  calls.push([nodeId, toolName, cwd, trust]);
  return toolName === "Write" ? { allow: false, reason: "範囲外" } : { allow: true };
};
const pre = (tool: string, session = "s-1", cwd = WT) => ({
  hook_event_name: "PreToolUse",
  session_id: session,
  cwd,
  tool_name: tool,
  tool_input: {},
});

describe("POST /v1/hook（トークンなし・session_id で引く）", () => {
  it("紐付けの前・知らない session_id には、判定を呼ばず、すぐ「何もしない」（none）を返す", async () => {
    calls.length = 0;
    const r = await start(policy);
    expect(await post(r.url, pre("Write"))).toEqual(UNBOUND);
    expect(
      await post(r.url, {
        hook_event_name: "Notification",
        session_id: "s-1",
        cwd: WT,
        notification_type: "permission_prompt",
        message: "m",
      }),
    ).toEqual(UNBOUND);
    expect(await post(r.url, { hook_event_name: "Stop", session_id: "s-1", cwd: WT })).toEqual(
      UNBOUND,
    );
    expect(calls).toEqual([]);
    expect(r.notifications).toEqual([]);
    expect(r.stops).toEqual([]);
  });

  it("形の違う入力・JSON でない入力も、none（ふつうのセッションに失敗を見せない）", async () => {
    const r = await start(policy);
    expect(await post(r.url, { hook_event_name: "Unknown", session_id: "s-1" })).toEqual(NONE);
    const res = await fetch(`${r.url}/v1/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(200);
  });

  it("範囲外の拒否: 紐付けた session_id の PreToolUse は、そのノードの範囲で判定し、trust: sessionIdOnly を写して呼ぶ", async () => {
    calls.length = 0;
    const r = await start(policy);
    r.table.register("s-1", "a", WT);
    const ng = await post(r.url, pre("Write"));
    expect(ng.json).toEqual({ ok: true, value: { decision: "deny", reason: "範囲外" } });
    const ok = await post(r.url, pre("Read", "s-1", `${WT}/sub`));
    expect(ok.json).toEqual({ ok: true, value: { decision: "allow" } });
    expect(calls).toEqual([
      ["a", "Write", WT, "sessionIdOnly"],
      ["a", "Read", `${WT}/sub`, "sessionIdOnly"],
    ]);
  });

  it("cwd が作業ツリーの外なら、紐付けた session_id でも none（名乗りを cwd でも確かめる）", async () => {
    calls.length = 0;
    const r = await start(policy);
    r.table.register("s-1", "a", WT);
    expect(await post(r.url, pre("Write", "s-1", "/wt/ab"))).toEqual(CWD);
    expect(await post(r.url, pre("Write", "s-1", "/elsewhere"))).toEqual(CWD);
    expect(calls).toEqual([]);
  });

  it.each(["permission_prompt", "idle_prompt", "elicitation_dialog", "agent_needs_input"])(
    "Notification（%s）は、trust: sessionIdOnly で報告に渡し、none を返す。窓口は状態を変えない",
    async (t) => {
      const r = await start(policy);
      r.table.register("s-1", "a", WT);
      const before = JSON.stringify(r.state);
      const res = await post(r.url, {
        hook_event_name: "Notification",
        session_id: "s-1",
        cwd: WT,
        notification_type: t,
        message: "Claude needs your permission",
        title: "Permission needed",
      });
      expect(res).toEqual(NONE);
      expect(r.notifications).toHaveLength(1);
      expect(r.notifications[0]?.nodeId).toBe("a");
      expect(r.notifications[0]?.via).toBe("sessionIdOnly");
      expect(r.notifications[0]?.h.notificationType).toBe(t);
      expect(r.notifications[0]?.h.message).toBe("Claude needs your permission");
      expect(JSON.stringify(r.state)).toBe(before);
    },
  );

  it("Stop で未読があるときは continue と理由を返し、なければ allow", async () => {
    const r = await start(policy, "受信箱を読む");
    r.table.register("s-1", "a", WT);
    const stop = { hook_event_name: "Stop", session_id: "s-1", cwd: WT, stop_hook_active: false };
    expect((await post(r.url, stop)).json).toEqual({
      ok: true,
      value: { decision: "continue", reason: "受信箱を読む" },
    });
    await server?.close();
    const q = await start(policy);
    q.table.register("s-1", "a", WT);
    expect((await post(q.url, stop)).json).toEqual({ ok: true, value: { decision: "allow" } });
  });

  it("SessionStart は受け付けない（仮の登録はしない）: none を返し、何も結ばない", async () => {
    calls.length = 0;
    const r = await start(policy);
    expect(
      await post(r.url, { hook_event_name: "SessionStart", session_id: "s-9", cwd: `${WT}/x` }),
    ).toEqual(NONE);
    expect(await post(r.url, pre("Write", "s-9"))).toEqual(UNBOUND);
    expect(calls).toEqual([]);
  });

  it("引いたノードが running・waiting でなければ none（判定を呼ばない）。理由は notLive と、その状態", async () => {
    calls.length = 0;
    const r = await start(policy);
    r.table.register("s-z", "z", WT);
    const res = await post(r.url, pre("Write", "s-z"));
    expect(res.json).toMatchObject({
      ok: true,
      value: { decision: "none", noneReason: "notLive" },
    });
    expect((res.json as { value: { state?: unknown } }).value.state).toEqual(expect.any(String));
    expect(calls).toEqual([]);
  });

  it("統合ノードに結んだ session_id は、none（子だけ）", async () => {
    calls.length = 0;
    const r = await start(policy);
    r.table.register("s-r", "root", WT);
    expect(await post(r.url, pre("Write", "s-r"))).toEqual(UNBOUND);
    expect(calls).toEqual([]);
  });
});

describe("記録の行為者の印", () => {
  it("sessionActor は system に trust: sessionIdOnly を付ける", async () => {
    const { sessionActor } = await import("../../src/api/hook.js");
    expect(sessionActor("sessionIdOnly")).toEqual({ system: true, trust: "sessionIdOnly" });
  });
});
