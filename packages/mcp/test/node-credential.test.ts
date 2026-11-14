import { describe, expect, it } from "vitest";
import { bindChild } from "../src/child-bind.js";
import { createNodeCredentialStore } from "../src/node-credential.js";

describe("createNodeCredentialStore", () => {
  it("set・clear で onChange を呼ぶ。外したら呼ばない", () => {
    const s = createNodeCredentialStore();
    const seen: (string | undefined)[] = [];
    const off = s.onChange((c) => seen.push(c?.nodeId));
    expect(s.get()).toBeUndefined();
    s.set({ nodeId: "a", token: "t".repeat(43) });
    expect(s.get()?.nodeId).toBe("a");
    s.clear();
    s.clear(); // 空のままなら呼ばない
    off();
    s.set({ nodeId: "b", token: "t".repeat(43) });
    expect(seen).toEqual(["a", undefined]);
  });
});

describe("bindChild の sessionId", () => {
  it("あれば送る。形が違えば送らない", async () => {
    const seen: Record<string, unknown>[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    await bindChild(
      { daemonUrl: "http://127.0.0.1:1", fetch: f, cwd: () => "/", sessionId: "s-1" },
      "a",
      "X",
    );
    await bindChild(
      { daemonUrl: "http://127.0.0.1:1", fetch: f, cwd: () => "/", sessionId: "a b" },
      "a",
      "X",
    );
    expect(seen[0]?.sessionId).toBe("s-1");
    expect(seen[1]).not.toHaveProperty("sessionId");
  });
});
