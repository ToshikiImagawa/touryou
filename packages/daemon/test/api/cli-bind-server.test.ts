import { type EventBody, foldEvents, type OrchEvent, type OrchState, ok } from "@touryou/core";
import { afterEach, describe, expect, it } from "vitest";
import { createBindCodes } from "../../src/api/bind.js";
import { createCredentialStore } from "../../src/api/credentials.js";
import { createBindWorktreeCheck } from "../../src/api/handlers/cli-bind-check.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";

// CLI の子の紐付け: 作業ツリーの確認・コードの再使用・期限切れ・別のノードのコード・紐付け前の書き込みの拒否。
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
      payload: { nodeId: "b", role: "implement", parentId: "root", dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "b", event: { type: "start" } } }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

const TREES: Record<string, string> = { a: "/w/trees/a", b: "/w/trees/b" };
let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const rig = async () => {
  let now = 1_000_000;
  const credentials = createCredentialStore({
    humanToken: "human-token-human-token-human-token-1234",
  });
  const bind = createBindCodes({ clock: () => now });
  const progress: unknown[] = [];
  server = createApiServer({
    credentials,
    bind,
    bindWorktreeOk: createBindWorktreeCheck({
      cwdOf: async (id) => TREES[id],
      // /w/link は /w/trees/a への symlink の扱い
      realpath: (p) => (p === "/w/link" ? "/w/trees/a" : p),
      gitIsFile: (t) => t.startsWith("/w/trees/"),
    }),
    getState: state,
    handlers: {
      "report.progress": (req) => {
        progress.push(req.params);
        return ok({ accepted: true });
      },
    },
  });
  const { url } = await server.listen(0);
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      json: (await res.json()) as { ok: boolean; value?: { token?: string } },
    };
  };
  const bindAs = (nodeId: string, bindCode: string, cwd?: string) =>
    post("/v1/bind", { nodeId, bindCode, ...(cwd === undefined ? {} : { cwd }) });
  const report = (token?: string) =>
    post(
      "/v1/request",
      { requestId: `p${++n}`, operation: "report.progress", params: { text: "x" } },
      token === undefined ? {} : { authorization: `Bearer ${token}` },
    );
  return { bind, bindAs, post, report, progress, advance: (ms: number) => (now += ms) };
};

describe("CLI の子の紐付け（POST /v1/bind と作業ツリーの確認）", () => {
  it("作業ツリーの中のセッションなら、子のトークンを受け取り、報告できる", async () => {
    const r = await rig();
    const res = await r.bindAs("a", r.bind.issue("a"), "/w/trees/a");
    expect(res.status).toBe(200);
    const token = res.json.value?.token as string;
    expect((await r.report(token)).status).toBe(200);
    expect(r.progress).toHaveLength(1);
  });

  it("symlink で入った作業ディレクトリも、実のパスで同じなら受け付ける", async () => {
    const r = await rig();
    expect((await r.bindAs("a", r.bind.issue("a"), "/w/link")).status).toBe(200);
  });

  it("作業ツリーでない・別のノードの作業ツリー・cwd なし・相対パスは 401。コードは消費しない", async () => {
    const r = await rig();
    const code = r.bind.issue("a");
    for (const cwd of ["/home/x/repo", "/w/trees/b", undefined, "trees/a"]) {
      expect((await r.bindAs("a", code, cwd)).status).toBe(401);
    }
    // 正しいセッションからは、同じコードで紐付けられる
    expect((await r.bindAs("a", code, "/w/trees/a")).status).toBe(200);
  });

  it("コードの再使用は 401", async () => {
    const r = await rig();
    const code = r.bind.issue("a");
    expect((await r.bindAs("a", code, "/w/trees/a")).status).toBe(200);
    expect((await r.bindAs("a", code, "/w/trees/a")).status).toBe(401);
  });

  it("期限切れは 401", async () => {
    const r = await rig();
    const code = r.bind.issue("a");
    r.advance(10 * 60_000);
    expect((await r.bindAs("a", code, "/w/trees/a")).status).toBe(401);
  });

  it("ほかのノードのコードは 401（作業ツリーが合っていても）", async () => {
    const r = await rig();
    const codeOfA = r.bind.issue("a");
    expect((await r.bindAs("b", codeOfA, "/w/trees/b")).status).toBe(401);
    // a のコードは、まだ a で使える
    expect((await r.bindAs("a", codeOfA, "/w/trees/a")).status).toBe(200);
  });

  it("紐付けの前は、子の書き込みの op（報告）を拒む（トークンなし・不正なトークン・失敗した紐付けのあと）", async () => {
    const r = await rig();
    expect((await r.report()).status).toBe(401);
    expect((await r.report("not-a-real-token-0123456789")).status).toBe(401);
    const failed = await r.bindAs("a", r.bind.issue("a"), "/home/x/repo");
    expect(failed.status).toBe(401);
    expect(failed.json.value).toBeUndefined();
    expect(r.progress).toHaveLength(0);
  });

  it("cwd が長すぎる本文は 400", async () => {
    const r = await rig();
    expect((await r.bindAs("a", r.bind.issue("a"), `/${"x".repeat(800)}`)).status).toBe(400);
  });
});

describe("POST /v1/bind の sessionId", () => {
  const rig2 = async () => {
    const credentials = createCredentialStore({
      humanToken: "human-token-human-token-human-token-1234",
    });
    const bind = createBindCodes();
    const bound: unknown[] = [];
    server = createApiServer({
      credentials,
      bind,
      onBindSucceeded: (nodeId, info) => bound.push({ nodeId, ...info }),
      getState: state,
      handlers: {},
    });
    const { url } = await server.listen(0);
    const call = async (body: unknown) =>
      (
        await fetch(`${url}/v1/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status;
    return { bind, bound, call };
  };

  it("正しいコードのときだけ、sessionId を渡す。コードが違えば呼ばない", async () => {
    const r = await rig2();
    expect(await r.call({ nodeId: "a", bindCode: "0".repeat(26), sessionId: "s-1" })).toBe(401);
    expect(r.bound).toEqual([]);
    expect(await r.call({ nodeId: "a", bindCode: r.bind.issue("a"), sessionId: "s-1" })).toBe(200);
    expect(r.bound).toEqual([{ nodeId: "a", sessionId: "s-1" }]);
  });

  it("sessionId の形が違えば 400", async () => {
    const r = await rig2();
    expect(await r.call({ nodeId: "a", bindCode: r.bind.issue("a"), sessionId: "a b" })).toBe(400);
    expect(r.bound).toEqual([]);
  });
});

describe("同時の bind と daemon の再起動", () => {
  it("同じコードで同時に 2 回 bind しても、成功は 1 回だけ", async () => {
    const r = await rig();
    const code = r.bind.issue("a");
    const [x, y] = await Promise.all([
      r.bindAs("a", code, "/w/trees/a"),
      r.bindAs("a", code, "/w/trees/a"),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 401]);
  });

  it("daemon の再起動のあと（コードはメモリだけ）: 前のコードは無効、出したトークンは有効のまま", async () => {
    const credentials = createCredentialStore({
      humanToken: "human-token-human-token-human-token-1234",
    });
    const before = createBindCodes();
    const code = before.issue("a");
    // 1 つ目の daemon で紐付け
    const start = async (bind: ReturnType<typeof createBindCodes>) => {
      const s = createApiServer({
        credentials,
        bind,
        getState: state,
        handlers: { "report.progress": () => ok({ accepted: true }) },
      });
      const { url } = await s.listen(0);
      return { s, url };
    };
    const first = await start(before);
    const res = await fetch(`${first.url}/v1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "a", bindCode: code }),
    });
    const token = ((await res.json()) as { value: { token: string } }).value.token;
    await first.s.close();
    // 起動し直した daemon（新しい BindCodes。トークンの記録〔credentials〕は残る）
    const second = await start(createBindCodes());
    server = second.s;
    const again = await fetch(`${second.url}/v1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "a", bindCode: code }),
    });
    expect(again.status).toBe(401);
    const used = await fetch(`${second.url}/v1/request`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        requestId: "p1",
        operation: "report.progress",
        params: { text: "x" },
      }),
    });
    expect(used.status).toBe(200);
  });

  it("ほかの生きているノードに結ばれた session_id では、bind を拒み、コードを消費しない", async () => {
    const credentials = createCredentialStore({
      humanToken: "human-token-human-token-human-token-1234",
    });
    const bind = createBindCodes();
    const taken = new Map([["s-b", "b"]]);
    server = createApiServer({
      credentials,
      bind,
      bindSessionOk: (nodeId, sid) => taken.get(sid) === undefined || taken.get(sid) === nodeId,
      getState: state,
      handlers: {},
    });
    const { url } = await server.listen(0);
    const call = async (sessionId: string, bindCode: string) =>
      (
        await fetch(`${url}/v1/bind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nodeId: "a", bindCode, sessionId }),
        })
      ).status;
    const code = bind.issue("a");
    expect(await call("s-b", code)).toBe(401);
    expect(await call("s-a", code)).toBe(200);
  });

  it("cwd と sessionId を上限まで書いた本文も、本文の上限（2 KiB）に収まる", async () => {
    const r = await rig();
    const big = await r.post("/v1/bind", {
      nodeId: "a",
      bindCode: r.bind.issue("a"),
      cwd: `/${"x".repeat(767)}`,
      sessionId: "s".repeat(128),
    });
    expect(big.status).toBe(401); // 作業ツリーでない（413 ではない）
  });
});
