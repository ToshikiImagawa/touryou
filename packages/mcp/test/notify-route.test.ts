/**
 * 知らせの宛先の mcp 側: 親の操作に session_id を付ける・根の購読に session を付ける・送り手のノードを知らせに入れる。
 * あわせて、子の購読の資格情報と 401 の扱い。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ok } from "@touryou/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sockPath } from "./sock-path.js";
import { proofOf } from "../src/identity.js";
import { createToolServer, type Relay } from "../src/index.js";
import { createNodeCredentialStore } from "../src/node-credential.js";
import { startNodeSubscriber } from "../src/node-subscriber.js";
import { MAX_SHOWN_CHILDREN, notificationText } from "../src/notify-socket.js";
import { startNotifications } from "../src/stdio.js";

const S1 = "11111111-1111-4111-8111-111111111111";
const dirs: string[] = [];
const servers: NetServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "touryou-route-"));
  dirs.push(d);
  return d;
};
const listen = async (): Promise<string> => {
  const path = sockPath(tmp());
  const server = createServer((c) => c.resume());
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  return path;
};

describe("知らせの文（送り手のノード）", () => {
  it("送り手のノードの ID を付ける。多ければ上限まで出して、残りは件数にする", () => {
    expect(notificationText(5)).toBe(
      "touryou の受信箱（inbox_fetch）を読んで、書かれた手順に従って（番号 5）",
    );
    expect(notificationText(5, ["a", "b"])).toBe(
      "touryou の受信箱（inbox_fetch）を読んで、書かれた手順に従って（番号 5。ノード a、b）",
    );
    const many = ["a", "b", "c", "d", "e"];
    expect(notificationText(5, many)).toContain(`ほか ${many.length - MAX_SHOWN_CHILDREN} 件`);
    expect(notificationText(5, ["x".repeat(200)]).length).toBeLessThan(120);
  });
});

describe("購読（session と送り手）", () => {
  it("session を付けて購読し、まとめた出来事の送り手のノードを知らせに渡す", async () => {
    const urls: string[] = [];
    const bodies = [
      'event: ready\ndata: {"from":1}\n\nid: 2\nevent: node\ndata: {"seq":2,"kind":"child","childId":"a"}\n\nid: 3\nevent: node\ndata: {"seq":3,"kind":"child","childId":"b"}\n\n',
    ];
    const f = (async (url: string) => {
      urls.push(String(url));
      const b = bodies.shift();
      return b === undefined
        ? new Response(null, { status: 503 })
        : new Response(b, { status: 200 });
    }) as unknown as typeof fetch;
    const calls: { seq: number; ids: readonly string[] }[] = [];
    const sub = startNodeSubscriber({
      fetch: f,
      sessionId: S1,
      coalesceMs: 5,
      sleep: () => new Promise((r) => setTimeout(r, 5)),
      target: async () => ok({ daemonUrl: "http://127.0.0.1:1", token: "t", nodeId: "root" }),
      verify: async () => true,
      notify: async (seq, ids) => {
        calls.push({ seq, ids });
        return { written: true };
      },
    });
    await until(() => calls.length > 0);
    sub.stop();
    await sub.done;
    expect(urls[0]).toBe(`http://127.0.0.1:1/v1/events?node=root&session=${S1}`);
    expect(calls[0]).toEqual({ seq: 3, ids: ["a", "b"] });
  });
});

describe("親の操作に session_id を付ける", () => {
  it("node_bindCode の転送に parentSessionId を足す（道具の引数には出さない）", async () => {
    const request = vi.fn(async () => ok({ instruction: "x", expiresAt: "t" }));
    const relay = { whoami: async () => ok({ role: "integrator" }), request } as unknown as Relay;
    const server = createToolServer({ role: "integrator", relay, parentSessionId: S1 });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "node_bindCode");
    expect(JSON.stringify(t?.inputSchema)).not.toContain("parentSessionId");
    await client.callTool({ name: "node_bindCode", arguments: { nodeId: "a" } });
    expect(request).toHaveBeenCalledWith("node.bindCode", { nodeId: "a", parentSessionId: S1 });
  });
});

describe("parent_request に plugin の場所を添える", () => {
  it("parent.request の転送に pluginRoot を足す（道具の引数には出さない）。ほかの操作には足さない", async () => {
    const request = vi.fn(async () => ok({ command: "x" }));
    const relay = { whoami: async () => ok({ role: "integrator" }), request } as unknown as Relay;
    const server = createToolServer({ role: "integrator", relay, pluginRoot: "/p/plugin" });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "parent_request");
    expect(JSON.stringify(t?.inputSchema)).not.toContain("pluginRoot");
    await client.callTool({ name: "parent_request", arguments: { nodeId: "a" } });
    expect(request).toHaveBeenCalledWith("parent.request", {
      nodeId: "a",
      pluginRoot: "/p/plugin",
    });
    await client.callTool({ name: "node_bindCode", arguments: { nodeId: "a" } });
    expect(request).toHaveBeenLastCalledWith("node.bindCode", { nodeId: "a" });
  });
});

describe("子の購読", () => {
  const identity = { daemonId: "a".repeat(32), secret: "b".repeat(64) };
  const ROOT_TOKEN = "root-token-root-token-1234567890";
  const rigOf = async (opts: { markerNodeId?: string; whoamiStatus?: () => number } = {}) => {
    const dir = tmp();
    const identityPath = join(dir, "daemon-identity");
    writeFileSync(identityPath, JSON.stringify({ version: 1, ...identity }));
    chmodSync(identityPath, 0o600);
    const socket = await listen();
    const seen: { path: string; auth: string | null; url: string }[] = [];
    let readyFrom = 1;
    const events: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const auth = new Headers(init?.headers).get("authorization");
      seen.push({ path: u.pathname, auth, url: String(url) });
      if (u.pathname === "/v1/identity") {
        const proof = proofOf(identity, "127.0.0.1:45001", u.searchParams.get("nonce") ?? "");
        return Response.json({ ok: true, value: { daemonId: identity.daemonId, proof } });
      }
      if (u.pathname === "/v1/whoami") {
        const status = opts.whoamiStatus?.() ?? 200;
        if (status !== 200) return Response.json({ ok: false }, { status });
        return Response.json({ ok: true, value: { role: "child", nodeId: "a" } });
      }
      const body = `event: ready\ndata: {"from":${readyFrom}}\n\n${events.shift() ?? ""}`;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const store = createNodeCredentialStore();
    const sub = startNotifications(
      [],
      // 根のトークンのファイルは置いてある（紐付け待ちでも、読まない・送らない）
      { CLAUDE_CODE_MESSAGING_SOCKET: socket, CLAUDE_CODE_SESSION_ID: S1, HOME: "/h" },
      { stderr: () => {} } as never,
      {
        fetch: f,
        sleep: () => new Promise((r) => setTimeout(r, 5)),
        files: {
          read: (p: string) => (p.endsWith("root-token") ? ROOT_TOKEN : "{}"),
          checkDir: () => undefined,
          modeString: () => "-rw-------",
        },
      },
      {
        credentials: store,
        endpoint: () => ok({ daemonUrl: "http://127.0.0.1:45001", identityPath }),
        ...(opts.markerNodeId === undefined ? {} : { markerNodeId: opts.markerNodeId }),
      },
    );
    return {
      seen,
      store,
      sub,
      pushEvent: (seq: number) => {
        events.push(`id: ${seq}\nevent: node\ndata: {"seq":${seq},"kind":"instruction"}\n\n`);
      },
      setReady: (n: number) => {
        readyFrom = n;
      },
    };
  };
  const CHILD = "child-token-child-token-1234";

  it("購読の口で 401 を受けたら、張り直しをやめ、入れ物を空にする（道具の口とそろえる）", async () => {
    const r = await rigOf({ whoamiStatus: () => 401 });
    r.store.set({ nodeId: "a", token: CHILD });
    await until(() => r.store.get() === undefined);
    const n = r.seen.filter((x) => x.path === "/v1/whoami").length;
    await new Promise((x) => setTimeout(x, 60));
    expect(r.seen.filter((x) => x.path === "/v1/whoami").length).toBe(n);
    expect(r.seen.some((x) => x.path === "/v1/events")).toBe(false);
    r.sub?.stop();
  });

  it("道具の口で入れ物が空になったら（401）、購読も止まる（以後、張り直さない）", async () => {
    const r = await rigOf();
    r.store.set({ nodeId: "a", token: CHILD });
    await until(() => r.seen.filter((x) => x.path === "/v1/events").length >= 2);
    r.store.clear();
    await new Promise((x) => setTimeout(x, 30));
    const n = r.seen.length;
    await new Promise((x) => setTimeout(x, 60));
    expect(r.seen.length).toBe(n);
    r.sub?.stop();
  });

  it("401 でない失敗（whoami の 500）では、いままでどおり張り直す", async () => {
    let calls = 0;
    const r = await rigOf({ whoamiStatus: () => (++calls <= 2 ? 500 : 200) });
    r.store.set({ nodeId: "a", token: CHILD });
    await until(() => r.seen.some((x) => x.path === "/v1/events"));
    expect(r.store.get()).toBeDefined();
    r.sub?.stop();
  });

  it("根のトークンのファイルがあっても、紐付け待ち・子の道では、根のトークンを一度も送らない。session も付けない", async () => {
    const r = await rigOf();
    await new Promise((x) => setTimeout(x, 30));
    r.store.set({ nodeId: "a", token: CHILD });
    await until(() => r.seen.some((x) => x.path === "/v1/events"));
    r.sub?.stop();
    const auths = r.seen.map((x) => x.auth).filter((a) => a !== null);
    expect(auths.length).toBeGreaterThan(0);
    expect(auths.every((a) => a === `Bearer ${CHILD}`)).toBe(true);
    expect(r.seen.some((x) => x.auth?.includes(ROOT_TOKEN))).toBe(false);
    expect(r.seen.some((x) => x.url.includes("session="))).toBe(false);
  });

  it("作業ツリーの印のノードと資格情報のノードが違えば、購読しない", async () => {
    const r = await rigOf({ markerNodeId: "other" });
    r.store.set({ nodeId: "a", token: CHILD });
    await new Promise((x) => setTimeout(x, 50));
    expect(r.seen).toEqual([]);
    r.sub?.stop();
  });

  it("失効（clear）のあと、同じノードに紐付け直したら、続きの seq から受ける", async () => {
    const r = await rigOf({ markerNodeId: "a" });
    r.pushEvent(5);
    r.store.set({ nodeId: "a", token: CHILD });
    await until(() => r.seen.filter((x) => x.path === "/v1/events").length >= 2);
    r.store.clear();
    await new Promise((x) => setTimeout(x, 20));
    const before = r.seen.length;
    r.store.set({ nodeId: "a", token: "child-token-child-token-5678" });
    await until(() => r.seen.slice(before).some((x) => x.path === "/v1/events"));
    r.sub?.stop();
    const again = r.seen.slice(before).find((x) => x.path === "/v1/events");
    expect(again?.url).toContain("after=5");
  });
});

describe("子を作る操作にも session_id を付ける", () => {
  it("node_spawn の転送に parentSessionId を足す", async () => {
    const request = vi.fn(async () => ok({ nodeId: "a", status: "running" }));
    const relay = { whoami: async () => ok({ role: "integrator" }), request } as unknown as Relay;
    const server = createToolServer({ role: "integrator", relay, parentSessionId: S1 });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({
      name: "node_spawn",
      arguments: {
        parentId: "root",
        role: "implement",
        objective: "o",
        acceptanceCriteria: ["c"],
        scope: { writableLocations: ["."], forbiddenLocations: [], allowedCommands: [] },
      },
    });
    const sent = request.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(sent[0]).toBe("node.spawn");
    expect(sent[1].parentSessionId).toBe(S1);
  });
});

describe("形の合わない session_id は付けない（should 3）", async () => {
  const { sessionIdFromEnv } = await import("../src/stdio.js");
  it("形が合えば付け、合わなければ付けない（親の操作は、付けずに通す）", async () => {
    expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: S1 })).toBe(S1);
    expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: "bad id/with space" })).toBeUndefined();
    expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: "" })).toBeUndefined();
    expect(sessionIdFromEnv({})).toBeUndefined();
    // 付けないときは、node_bindCode・node_spawn を parentSessionId なしで転送する
    const request = vi.fn(async () => ok({ instruction: "x", expiresAt: "t" }));
    const relay = { whoami: async () => ok({ role: "integrator" }), request } as unknown as Relay;
    const sid = sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: "bad id" });
    const server = createToolServer({
      role: "integrator",
      relay,
      ...(sid === undefined ? {} : { parentSessionId: sid }),
    });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "node_bindCode", arguments: { nodeId: "a" } });
    expect(request).toHaveBeenCalledWith("node.bindCode", { nodeId: "a" });
  });
});
