import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ok } from "@touryou/core";
import { describe, expect, it } from "vitest";
import type { Relay } from "../src/relay.js";
import { createToolServer } from "../src/server.js";

// 子の受信箱: 子の道具 inbox_fetch は child.inbox を呼び、応答を受け取ってから ackThrough で受け取りを知らせる。
describe("子の inbox_fetch（child.inbox）", () => {
  const setup = (instructions: { seq: number; received: boolean }[]) => {
    const calls: { op: string; params: unknown }[] = [];
    const relay: Relay = {
      whoami: async () => ok({ role: "child", nodeId: "a" }),
      request: async (op, params) => {
        calls.push({ op, params });
        return ok({
          brief: { nodeId: "a", objective: "直す", dependsOn: [] },
          instructions: instructions.map((i) => ({ ...i, at: "t", quotedText: "> x" })),
        });
      },
    };
    return { calls, server: createToolServer({ role: "child", relay }) };
  };
  const call = async (
    server: ReturnType<typeof createToolServer>,
    args: Record<string, unknown>,
  ) => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    const r = (await client.callTool({ name: "inbox_fetch", arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { names, isError: r.isError === true, body: JSON.parse(r.content[0]?.text ?? "null") };
  };

  it("child.inbox を呼び、まだ受け取っていなかった指示の最大の番号を ackThrough で知らせる。応答に引用の注意を付ける", async () => {
    const s = setup([
      { seq: 3, received: true },
      { seq: 5, received: false },
      { seq: 7, received: false },
    ]);
    const r = await call(s.server, { all: true });
    expect(r.names).toContain("inbox_fetch");
    expect(r.isError).toBe(false);
    expect(r.body.note).toContain("引用");
    expect(r.body.note).toContain("頭の > を除く");
    expect(r.body.note).toContain("report_decision");
    expect(r.body.brief.nodeId).toBe("a");
    expect(s.calls).toEqual([
      { op: "child.inbox", params: { all: true } },
      { op: "child.inbox", params: { ackThrough: 7 } },
    ]);
  });

  it("新しい指示がなければ、ackThrough を送らない。ackThrough は道具の引数では受けない", async () => {
    const s = setup([]);
    await call(s.server, {});
    expect(s.calls).toEqual([{ op: "child.inbox", params: {} }]);
    const t = setup([]);
    const bad = await call(t.server, { ackThrough: 9 });
    expect(bad.isError).toBe(true);
    expect(t.calls).toEqual([]);
  });
});
