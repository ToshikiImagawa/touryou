import type { EventBody, Failure, Result } from "@touryou/core";
import { failure, ok, type ProcessInfo } from "@touryou/core";
import type {
  Capabilities,
  EventSink,
  RuntimeAdapter,
  SinkRequest,
  StartRequest,
  StopRequest,
  Timers,
} from "../../src/sdk/runtime.js";

export const settle = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** 手動で進める時計。`advance` で期限の来たタイマーを発火する。 */
export class FakeTimers implements Timers {
  t = 0;

  now(): number {
    return this.t;
  }
  private readonly pending: { at: number; fire: () => void; id: number }[] = [];
  private nextId = 1;

  after(ms: number): { promise: Promise<void>; cancel(): void } {
    const id = this.nextId++;
    let fire!: () => void;
    const promise = new Promise<void>((r) => {
      fire = r;
    });
    this.pending.push({ at: this.t + ms, fire, id });
    return {
      promise,
      cancel: () => {
        const i = this.pending.findIndex((p) => p.id === id);
        if (i >= 0) this.pending.splice(i, 1);
      },
    };
  }

  sleep(ms: number): Promise<void> {
    return this.after(ms).promise;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** 時間を進め、期限の来たタイマーを順に発火する（発火のたびに非同期の続きを実行させる）。 */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      this.pending.sort((a, b) => a.at - b.at);
      const next = this.pending[0];
      if (next === undefined || next.at > target) break;
      this.pending.shift();
      this.t = next.at;
      next.fire();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

/** 偽の CLI の子の 1 回の起動（`FakeCliAdapter.start` の記録）。 */
export class FakeCliSession {
  private resolveInit!: () => void;
  readonly initialized: Promise<void>;
  constructor(readonly request: StartRequest) {
    this.initialized = new Promise((r) => {
      this.resolveInit = r;
    });
  }
  /** 子に渡したトークン。 */
  get token(): string {
    return this.request.mcp?.token ?? "";
  }
  /** 起動の完了を返させる（`autoInit` が false のとき）。 */
  init(): void {
    this.resolveInit();
  }
}

/**
 * 偽の CLI の子のアダプタ（SDK による起動を外したあと、子が動く前提の試験で使う）。
 * 起動を記録して成功を返し、停止はすぐに stopped を返す。
 */
export class FakeCliAdapter implements RuntimeAdapter {
  readonly kind = "cli" as const;
  readonly sessions: FakeCliSession[] = [];
  /** 起動と同時に完了を返す（既定）。false なら、`init()` まで待つ。 */
  autoInit = true;
  private readonly live = new Set<string>();
  has(nodeId: string): boolean {
    return this.live.has(nodeId);
  }
  capabilities(_nodeId: string): Capabilities {
    return {
      send: "delayed",
      stopGraceful: true,
      stopImmediate: true,
      hooks: "ok",
      sessionId: true,
    };
  }
  async start(request: StartRequest) {
    const s = new FakeCliSession(request);
    this.sessions.push(s);
    if (this.autoInit) s.init();
    await s.initialized;
    this.live.add(request.nodeId);
    return ok({
      sessionId: `session-${this.sessions.length}`,
      cwd: request.worktreePath,
      removedEnv: [],
    });
  }
  async send(_nodeId: string, _text: string) {
    return ok({ status: "queued" as const });
  }
  /** 停止の観測と確認を記録する先（daemon の起動のあとに、試験が入れる）。 */
  sink: EventSink | undefined;
  async stop(nodeId: string, request: StopRequest) {
    this.live.delete(nodeId);
    this.sink?.recordAll([
      {
        requestId: `fake-observed-${request.stopSeq}`,
        actor: { system: true },
        body: {
          type: "node.stopObserved",
          payload: { nodeId, outcome: "withinGrace", stopSeq: request.stopSeq },
        },
      },
      {
        requestId: `fake-confirmed-${request.stopSeq}`,
        actor: { system: true },
        body: { type: "node.stateChanged", payload: { nodeId, event: { type: "confirmStopped" } } },
      },
    ]);
    return ok({ state: "stopped" as const, outcome: "withinGrace" as const, blockers: [] });
  }
  updateScope() {
    return ok(undefined);
  }
}

export class FakeSink implements EventSink {
  readonly records: { requestId: string; body: EventBody; actor: SinkRequest["actor"] }[] = [];
  /** 次の n 回の記録を失敗させる。 */
  failNext = 0;
  /** 1 トランザクションで記録した件数の列（`recordAll` の呼び出しごと）。 */
  readonly groups: number[] = [];
  recordAll(reqs: readonly SinkRequest[]): Result<unknown, Failure> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { ok: false, error: failure("storeError", "disk full", "再試行する") };
    }
    for (const req of reqs) {
      this.records.push({ requestId: req.requestId, body: req.body, actor: req.actor });
    }
    this.groups.push(reqs.length);
    return ok(undefined);
  }
  record(req: SinkRequest): Result<unknown, Failure> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { ok: false, error: failure("storeError", "disk full", "再試行する") };
    }
    this.records.push({ requestId: req.requestId, body: req.body, actor: req.actor });
    return ok(undefined);
  }
  get types(): string[] {
    return this.records.map((r) =>
      r.body.type === "node.stateChanged"
        ? `${r.body.type}:${r.body.payload.event.type}`
        : r.body.type === "node.stopObserved"
          ? `${r.body.type}:${r.body.payload.outcome}`
          : r.body.type,
    );
  }
}

/** プロセス一覧の列。呼ばれるたびに次の値を返し、尽きたら最後の値を返し続ける。 */
export const probeSequence = (...seq: (readonly ProcessInfo[] | null)[]) => {
  let i = 0;
  const calls: string[] = [];
  const probe = async (worktree: string): Promise<readonly ProcessInfo[] | null> => {
    calls.push(worktree);
    const v = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return v === undefined ? [] : v;
  };
  return { probe, calls };
};
