/**
 * CLI の子の起動時の整合。既定の CLI のアダプタ（親への依頼）で daemon を作り、記録を置いて
 * から作り直す（再起動）。
 * - 破棄の判断を記録した直後に落ちた: 起動時に、旗つきの削除の依頼が 1 件だけ増える。
 * - 猶予の調べの最中（stopping）に落ちた: 起動時に、claude stop の依頼を作って停止未完了にする（開いている依頼があれば作らない）。
 */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBody, type Failure, ok, type Result } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { createDaemon, type DaemonDeps } from "../src/compose.js";
import type { DaemonConfig } from "../src/config.js";

const setup = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-cli-startup-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  const config: DaemonConfig = {
    stateDir: join(base, "state"),
    repoRoot,
    worktreeRoot,
    rootCwd: repoRoot,
    rootNodeId: "root",
    rootScope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
    port: 0,
  };
  const deps: DaemonDeps = {
    worktree: {
      factsFor: async () => undefined,
      removeWorktree: async (): Promise<Result<undefined, Failure>> => ok(undefined),
      provisionWorktree: async ({ nodeId }) => ok({ worktreePath: join(worktreeRoot, nodeId) }),
      cwdOf: async () => undefined,
    },
    probe: async () => [],
    logLine: () => undefined,
  };
  const open = () => {
    const made = createDaemon(config, deps);
    if (!made.ok) throw new Error(`${made.error.code}: ${made.error.cause}`);
    return made.value;
  };
  return { open, worktreeRoot };
};

let n = 0;
/** 子 a を、親が起動を報告した状態まで記録する。 */
const seed = (d: ReturnType<ReturnType<typeof setup>["open"]>, worktree: string) => {
  const add = (body: EventBody) => {
    const r = d.log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  add({
    type: "node.created",
    payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } });
  add({
    type: "node.parentRequested",
    payload: { nodeId: "a", requestRef: "preq-launch", kind: "launch", worktree },
  });
  add({
    type: "node.parentReported",
    payload: { nodeId: "a", requestRef: "preq-launch", outcome: "done", sessionRef: "sess-a" },
  });
  return add;
};

describe("CLI の子の起動時の整合（落ちた時点ごとの回復）", () => {
  it("破棄の判断を記録した直後に落ちても、起動時に旗つきの削除の依頼が 1 件だけ増える", async () => {
    const s = setup();
    const d1 = s.open();
    const add = seed(d1, join(s.worktreeRoot, "a"));
    add({
      type: "node.stateChanged",
      payload: { nodeId: "a", event: { type: "stop", mode: "immediate" } },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "confirmStopped" } } });
    add({
      type: "node.parentRequested",
      payload: {
        nodeId: "a",
        requestRef: "preq-rm",
        kind: "remove",
        worktree: join(s.worktreeRoot, "a"),
      },
    });
    add({
      type: "node.parentReported",
      payload: { nodeId: "a", requestRef: "preq-rm", outcome: "failed", reason: "unpushed" },
    });
    // 破棄の判断を記録した直後に落ちた（削除の依頼はまだない）。記録の通知の中の追記（次の小さな仕事）が走る前に閉じる
    add({ type: "node.discardDecided", payload: { nodeId: "a", noTip: true } });
    await d1.stop();
    const removesOf = (d: typeof d1) =>
      d.log.state().parentRequests.filter((r) => r.nodeId === "a" && r.kind === "remove");
    const d2 = s.open();
    // どちらの順で落ちても（通知の中の追記が走ったか、まだか）、旗つきの削除の依頼は 1 件だけ（拒まれたもの + 新しい 1 件）
    expect(removesOf(d2)).toHaveLength(2);
    expect(removesOf(d2).filter((r) => r.report === undefined)).toHaveLength(1);
    await d2.stop();
    // もう一度起動しても、増えない
    const d3 = s.open();
    expect(removesOf(d3).filter((r) => r.report === undefined)).toHaveLength(1);
    expect(removesOf(d3)).toHaveLength(2);
    await d3.stop();
  });

  it("猶予の調べの最中（stopping）に落ちたら、起動時に claude stop を依頼して停止未完了にする。開いている依頼があれば作らない", async () => {
    const s = setup();
    const d1 = s.open();
    const add = seed(d1, join(s.worktreeRoot, "a"));
    add({
      type: "node.stateChanged",
      payload: { nodeId: "a", event: { type: "stop", mode: "graceful" } },
    });
    await d1.stop();
    const d2 = s.open();
    const st = d2.log.state();
    expect(st.nodes.find((x) => x.id === "a")?.state).toBe("stopIncomplete");
    const stops = st.parentRequests.filter((r) => r.nodeId === "a" && r.kind === "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.report).toBeUndefined();
    expect(
      st.inbox.some(
        (i) =>
          i.nodeId === "a" &&
          i.kind === "stopIncomplete" &&
          (i.summary ?? "").includes("claude stop"),
      ),
    ).toBe(true);
    await d2.stop();
    // 開いている依頼があるので、もう一度起動しても作らない（状態も stopIncomplete のまま）
    const d3 = s.open();
    expect(
      d3.log.state().parentRequests.filter((r) => r.nodeId === "a" && r.kind === "stop"),
    ).toHaveLength(1);
    await d3.stop();
  });
});
