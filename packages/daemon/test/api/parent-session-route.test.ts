/**
 * 知らせの宛先（設計 6.3）: 親のセッションの記録（`node.parentSessionSet`）と、それによる宛先の決め。
 */
import { type EventBody, foldEvents, type NodeEvent, type OrchEvent } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createBindCodes } from "../../src/api/bind.js";
import { createBindHandlers } from "../../src/api/handlers/bind-handlers.js";
import type { HandlerRequest } from "../../src/api/server.js";
import { createSseHub, nodeFeedOf, type SseSink } from "../../src/api/sse-hub.js";
import { validateParams } from "../../src/api/validate.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
let n = 0;
const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => "2026-11-12T00:00:00Z" });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
    return r.value.event.seq;
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) => {
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
    ev(nodeId, { type: "start" });
  };
  node("root", "integrator", null);
  node("a", "implement", "root");
  node("b", "implement", "root");
  const h = createBindHandlers({
    log,
    bind: createBindCodes({ clock: () => Date.parse("2026-11-12T00:00:00Z") }),
    cli: true,
    baseUrl: () => "http://127.0.0.1:7777",
  });
  const bindCode = (nodeId: string, parentSessionId?: string) =>
    h["node.bindCode"]({
      requestId: `q-${++n}`,
      operation: "node.bindCode",
      role: "integrator",
      caller: { nodeId: "root" },
      params: { nodeId, ...(parentSessionId === undefined ? {} : { parentSessionId }) },
    } as unknown as HandlerRequest<"node.bindCode">);
  const inbox = (nodeId: string, kind: string) =>
    add({
      type: "inbox.added",
      payload: { id: `i-${++n}`, nodeId, kind, summary: "s" },
    } as unknown as EventBody);
  return { log, bindCode, inbox, add };
};

describe("親のセッションの記録（node.parentSessionSet）", () => {
  it("node.bindCode に parentSessionId を付けると、その子の親のセッションとして記録する。付けなければ記録しない", () => {
    const r = rig();
    expect(r.bindCode("a").ok).toBe(true);
    expect(r.log.state().nodes.find((x) => x.id === "a")?.parentSession).toBeUndefined();
    expect(r.bindCode("a", S1).ok).toBe(true);
    expect(r.log.state().nodes.find((x) => x.id === "a")?.parentSession?.sessionId).toBe(S1);
    expect(r.bindCode("a", S2).ok).toBe(true); // 親が移れば、新しい方
    expect(r.log.state().nodes.find((x) => x.id === "a")?.parentSession?.sessionId).toBe(S2);
  });

  it("窓口の検査: parentSessionId の形が違えば拒否する。知らない鍵も拒否する", () => {
    expect(validateParams("node.bindCode", { nodeId: "a", parentSessionId: S1 }).ok).toBe(true);
    expect(validateParams("node.bindCode", { nodeId: "a", parentSessionId: "../x y" }).ok).toBe(
      false,
    );
    expect(validateParams("node.bindCode", { nodeId: "a", other: 1 }).ok).toBe(false);
  });

  it("畳み込み: 形の違う session_id・知らないノードは拒否する", () => {
    const base: OrchEvent[] = [
      {
        seq: 1,
        at: "t",
        requestId: "r1",
        actor: { system: true },
        type: "node.created",
        payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
      } as OrchEvent,
    ];
    const ps = (nodeId: string, sessionId: string) =>
      ({
        seq: 2,
        at: "t",
        requestId: "r2",
        actor: { system: true },
        type: "node.parentSessionSet",
        payload: { nodeId, sessionId },
      }) as OrchEvent;
    expect(foldEvents([...base, ps("root", S1)]).ok).toBe(true);
    expect(foldEvents([...base, ps("root", "bad id")]).ok).toBe(false);
    expect(foldEvents([...base, ps("zzz", S1)]).ok).toBe(false);
  });
});

describe("宛先の決め（nodeFeedOf）", () => {
  it("直接の子の受信箱の項目は、その子の親のセッションへ。子に関わらない出来事は、最後に親の操作をしたセッションへ", () => {
    const r = rig();
    r.bindCode("a", S1);
    r.bindCode("b", S2); // 最後の親の操作は S2
    const ia = r.inbox("a", "failure");
    const ib = r.inbox("b", "failure");
    const ic = r.inbox("a", "info"); // 知らせない種類
    const ins = r.add({ type: "node.instructed", payload: { nodeId: "root", text: "x" } });
    const feed = nodeFeedOf(r.log.state(), "root", 0);
    expect(feed.find((e) => e.seq === ia)).toEqual({
      seq: ia,
      kind: "child",
      childId: "a",
      target: S1,
    });
    expect(feed.find((e) => e.seq === ib)).toEqual({
      seq: ib,
      kind: "child",
      childId: "b",
      target: S2,
    });
    expect(feed.find((e) => e.seq === ic)).toBeUndefined();
    expect(feed.find((e) => e.seq === ins)).toEqual({ seq: ins, kind: "instruction", target: S2 });
  });

  it("親の操作がまだ記録にない間は、宛先を決めず、統合ノードの出来事には exclusive を付ける（子のノードには付けない）", () => {
    const r = rig();
    const ia = r.inbox("a", "failure");
    expect(nodeFeedOf(r.log.state(), "root", 0).find((e) => e.seq === ia)).toEqual({
      seq: ia,
      kind: "child",
      childId: "a",
      exclusive: true,
    });
    const ins = r.add({ type: "node.instructed", payload: { nodeId: "a", text: "x" } });
    expect(nodeFeedOf(r.log.state(), "a", 0).find((e) => e.seq === ins)).toEqual({
      seq: ins,
      kind: "instruction",
    });
  });
});

class Sink implements SseSink {
  written: string[] = [];
  write(c: string) {
    this.written.push(c);
    return true;
  }
  end() {}
  destroy() {}
  readonly destroyed = false;
  onDrain() {}
  onClose(_cb: () => void) {}
  get text() {
    return this.written.join("");
  }
}

describe("宛先の決め（ハブ）", () => {
  it("宛先のある出来事は、その session_id の接続にだけ流す。合う接続がなければ、どこにも流さない。外に宛先を出さない", () => {
    const r = rig();
    r.bindCode("a", S1);
    const ia = r.inbox("a", "failure");
    const state = r.log.state();
    const hub = createSseHub({
      spec: {
        maxConnections: 1,
        coalesceMs: 10,
        heartbeatMs: 1000,
        drainTimeoutMs: 500,
        maxLifetimeMs: 60_000,
      },
      getSeq: () => state.lastSeq,
      isTokenValid: () => true,
      nowMs: () => 0,
      autoStart: false,
      nodeFeed: (id, after) => nodeFeedOf(state, id, after),
    });
    const s1 = new Sink();
    const s2 = new Sink();
    const none = new Sink();
    hub.addNode(s1, "t", "root", 0, S1);
    hub.addNode(s2, "t", "root", 0, S2);
    hub.addNode(none, "t", "root", 0);
    expect(s1.text).toContain(`id: ${ia}\n`);
    expect(s1.text).toContain('"childId":"a"');
    expect(s1.text).not.toContain(S1);
    expect(s2.text).not.toContain(`id: ${ia}\n`);
    expect(none.text).not.toContain(`id: ${ia}\n`);
  });
});

describe("親の操作がまだ記録にない間（決定）", () => {
  const hubOf = (state: ReturnType<ReturnType<typeof rig>["log"]["state"]>) =>
    createSseHub({
      spec: {
        maxConnections: 1,
        coalesceMs: 10,
        heartbeatMs: 1000,
        drainTimeoutMs: 500,
        maxLifetimeMs: 60_000,
      },
      getSeq: () => state.lastSeq,
      isTokenValid: () => true,
      nowMs: () => 0,
      autoStart: false,
      nodeFeed: (id, after) => nodeFeedOf(state, id, after),
    });

  it("根の購読がちょうど 1 本なら、そこに流す", () => {
    const r = rig();
    const ia = r.inbox("a", "failure");
    const hub = hubOf(r.log.state());
    const s1 = new Sink();
    hub.addNode(s1, "t", "root", 0, S1);
    expect(s1.text).toContain(`id: ${ia}\n`);
  });

  it("購読の接続が 2 本以上なら、session の有無にかかわらず、どれにも流さない", () => {
    const r = rig();
    const ia = r.inbox("a", "failure");
    const hub = hubOf(r.log.state());
    const first = new Sink();
    const other = new Sink();
    // 先に 2 本目をつないでおく（出来事より後の起点）。1 本目は出来事より前の起点からつなぐ（つないだ時点で 2 本）
    hub.addNode(other, "t", "root", Number.MAX_SAFE_INTEGER);
    hub.addNode(first, "t", "root", 0, S1);
    expect(first.text).not.toContain(`id: ${ia}\n`);
    expect(other.text).not.toContain(`id: ${ia}\n`);
  });

  it("session のない接続でも、ちょうど 1 本なら流す", () => {
    const r = rig();
    const ia = r.inbox("a", "failure");
    const hub = hubOf(r.log.state());
    const only = new Sink();
    hub.addNode(only, "t", "root", 0);
    expect(only.text).toContain(`id: ${ia}\n`);
  });
});

describe("宛先は配る時点で決まる", () => {
  it("親が A から B に移ると、A がまだ受けていない古い出来事も B に流れる", () => {
    const r = rig();
    r.bindCode("a", S1);
    const ia = r.inbox("a", "failure"); // Aのときの出来事
    r.bindCode("a", S2); // 親が Bに移る
    const state = r.log.state();
    const hub = createSseHub({
      spec: {
        maxConnections: 1,
        coalesceMs: 10,
        heartbeatMs: 1000,
        drainTimeoutMs: 500,
        maxLifetimeMs: 60_000,
      },
      getSeq: () => state.lastSeq,
      isTokenValid: () => true,
      nowMs: () => 0,
      autoStart: false,
      nodeFeed: (id, after) => nodeFeedOf(state, id, after),
    });
    const a = new Sink();
    const b = new Sink();
    hub.addNode(a, "t", "root", 0, S1);
    hub.addNode(b, "t", "root", 0, S2);
    expect(a.text).not.toContain(`id: ${ia}\n`);
    expect(b.text).toContain(`id: ${ia}\n`);
  });
});

describe("同じ session_id では記録し直さない", () => {
  it("同じ session_id で node.bindCode を呼び直しても、記録は 1 件のまま", () => {
    const r = rig();
    r.bindCode("a", S1);
    const seq = r.log.state().nodes.find((x) => x.id === "a")?.parentSession?.seq;
    r.bindCode("a", S1);
    expect(r.log.state().nodes.find((x) => x.id === "a")?.parentSession?.seq).toBe(seq);
  });
});

describe("「1 本なら流す」は統合ノードだけ", () => {
  const hubFor = (get: () => ReturnType<ReturnType<typeof rig>["log"]["state"]>) =>
    createSseHub({
      spec: {
        maxConnections: 1,
        coalesceMs: 10,
        heartbeatMs: 1000,
        drainTimeoutMs: 500,
        maxLifetimeMs: 60_000,
      },
      getSeq: () => get().lastSeq,
      isTokenValid: () => true,
      nowMs: () => 0,
      autoStart: false,
      nodeFeed: (id, after) => nodeFeedOf(get(), id, after),
    });

  it("子のノードは、張り直しの重なりで 2 本になっても、指示が両方に届く", () => {
    const r = rig();
    const hub = hubFor(() => r.log.state());
    const one = new Sink();
    const two = new Sink();
    hub.addNode(one, "t", "a", 0);
    hub.addNode(two, "t", "a", 0);
    const ins = r.add({ type: "node.instructed", payload: { nodeId: "a", text: "x" } });
    hub.tick();
    expect(one.text).toContain(`id: ${ins}\n`);
    expect(two.text).toContain(`id: ${ins}\n`);
  });

  it("統合ノードは、2 本の間は流さず取り置き、1 本に戻れば届く", () => {
    const r = rig();
    let closeSecond: (() => void) | undefined;
    const hub = hubFor(() => r.log.state());
    const first = new Sink();
    const second = new Sink();
    second.onClose = (cb: () => void) => {
      closeSecond = cb;
    };
    hub.addNode(first, "t", "root", r.log.state().lastSeq, S1);
    hub.addNode(second, "t", "root", r.log.state().lastSeq);
    const ia = r.inbox("a", "failure");
    hub.tick();
    expect(first.text).not.toContain(`id: ${ia}\n`);
    expect(second.text).not.toContain(`id: ${ia}\n`);
    closeSecond?.(); // 2 本目が切れて、1 本に戻る
    hub.tick();
    expect(first.text).toContain(`id: ${ia}\n`);
  });

  it("統合ノードの同じ session_id の接続どうしは 1 本と数える（張り直しの重なりで落とさない）", () => {
    const r = rig();
    const hub = hubFor(() => r.log.state());
    const old = new Sink();
    const fresh = new Sink();
    hub.addNode(old, "t", "root", r.log.state().lastSeq, S1);
    hub.addNode(fresh, "t", "root", r.log.state().lastSeq, S1);
    const ia = r.inbox("a", "failure");
    hub.tick();
    expect(old.text).toContain(`id: ${ia}\n`);
    expect(fresh.text).toContain(`id: ${ia}\n`);
  });
});

describe("取り置きは最大の 1 件", () => {
  const hubFor = (get: () => ReturnType<ReturnType<typeof rig>["log"]["state"]>) =>
    createSseHub({
      spec: {
        maxConnections: 1,
        coalesceMs: 10,
        heartbeatMs: 1000,
        drainTimeoutMs: 500,
        maxLifetimeMs: 60_000,
      },
      getSeq: () => get().lastSeq,
      isTokenValid: () => true,
      nowMs: () => 0,
      autoStart: false,
      nodeFeed: (id, after) => nodeFeedOf(get(), id, after),
    });
  const closable = () => {
    const s = new Sink();
    let close: (() => void) | undefined;
    s.onClose = (cb: () => void) => {
      close = cb;
    };
    return { s, close: () => close?.() };
  };

  it("2 本の間に出来事が 100 件を超えても、1 本に戻れば最大の番号が 1 つ届く", () => {
    const r = rig();
    const hub = hubFor(() => r.log.state());
    const first = new Sink();
    const second = closable();
    hub.addNode(first, "t", "root", r.log.state().lastSeq, S1);
    hub.addNode(second.s, "t", "root", r.log.state().lastSeq);
    let last = 0;
    for (let i = 0; i < 120; i++) {
      last = r.inbox("a", "failure");
      if (i % 30 === 0) hub.tick();
    }
    for (let i = 0; i < 5; i++) hub.tick();
    expect(first.text).not.toContain("event: node");
    second.close();
    hub.tick();
    const ids = [...first.text.matchAll(/id: (\d+)\nevent: node/g)].map((m) => Number(m[1]));
    expect(ids).toEqual([last]);
  });

  it("取り置いたあとに宛先が決まり、その接続あてでなければ配らない", () => {
    const r = rig();
    const hub = hubFor(() => r.log.state());
    const first = new Sink();
    const second = closable();
    hub.addNode(first, "t", "root", r.log.state().lastSeq, S1);
    hub.addNode(second.s, "t", "root", r.log.state().lastSeq);
    const ia = r.inbox("a", "failure");
    hub.tick(); // 2 本なので取り置き
    r.bindCode("a", S2); // そのあとで、a の親は S2 に決まる
    second.close();
    hub.tick();
    expect(first.text).not.toContain(`id: ${ia}\n`);
  });
});
