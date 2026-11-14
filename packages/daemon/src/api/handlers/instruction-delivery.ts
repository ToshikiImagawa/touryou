/**
 * 追加指示の配送（設計 6.3・NFR_014）。**daemon は子を呼ばない**。指示は記録（`node.instructed`）に置かれ、
 * それ自体が、そのノードの購読（`GET /v1/events?node=`）に `instruction` の出来事として流れる。子の mcp が受けて、自分のセッションの
 * ソケットに 1 行の知らせを書き、子は受信箱（`inbox_fetch`。子のロールでは `child.inbox`）で中身を読む。`node.send` と、差し戻しの
 * feedback（`node.review`）が使う。
 * - **「配送済み」の意味**: 「配送済み」（`node.instructionDelivered`・`deliveredSeq`）は、子が `child.inbox` で受け取った記録
 *   （`child-inbox-handlers.ts`）。ここでは記録しない（以前は「購読に流せる状態にした」記録をここで付けていた）。ここでは、知らせを
 *   出せるノード（動作中・判断待ち）かだけを確かめる。知らせは、記録の seq から 1 回だけ流れる（未読のままでも出し直さない）。
 *
 * - 配送の失敗は、そのまま返す（記録済みの指示は残り、同じ要求の再送で、未配送のときだけ送り直す）。
 * - 送ったあとの配送の記録に失敗したら、送信は成功として返す（記録されないので、再送で重複して届きうる＝少なくとも 1 回）。
 *   失敗は `onFailure` に残す。
 */

import { type Failure, failure, type OrchState, type Result } from "@touryou/core";
import type { LogPort } from "./context.js";

export interface InstructionDelivery {
  /** 知らせを出せるノードか（記録にあり、動作中・判断待ち）。ない子には、記録する前に失敗させる。 */
  available(nodeId: string): boolean;
  /**
   * 状態が `next` に移ったあとに知らせを出せるか（記録にあり、`next` が動作中・判断待ち）。差し戻し（done → running）の前の確かめに
   * 使う（done のいまは available が偽なので）。
   */
  availableAfter(nodeId: string, next: string): boolean;
  /** 指示（`node.instructed` の `seq`）を子へ届け、成功したら配送を記録する。 */
  deliver(nodeId: string, text: string, instructedSeq: number): Promise<Result<undefined, Failure>>;
}

export interface InstructionDeliveryDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

/** 指示を子が受け取ったか（`child.inbox`。記録がなければ、まだとして扱う）。 */
export const isDelivered = (state: OrchState, instructedSeq: number): boolean =>
  state.instructions.find((i) => i.seq === instructedSeq)?.deliveredSeq !== undefined;

/**
 * 配送の手順（知らせを出せるかの確かめ）を済ませた指示の seq（ログごと。メモリだけ）。「済ませたか」は記録に残さない
 * （記録の `deliveredSeq` は、子が受け取った印）。daemon の再起動で消えるが、そのときは配送の手順をもう一度通るだけで、知らせは
 * 記録の seq から 1 回だけ流れる（重複しない）。
 */
const sentByLog = new WeakMap<object, Set<number>>();

/** 配送の手順を済ませたか、子が受け取ったか（送り直しの要否の判定に使う）。 */
export const wasNotified = (log: object, state: OrchState, instructedSeq: number): boolean =>
  sentByLog.get(log)?.has(instructedSeq) === true || isDelivered(state, instructedSeq);

const DELIVERABLE = new Set(["running", "waiting"]);

export function createInstructionDelivery(deps: InstructionDeliveryDeps): InstructionDelivery {
  const known = (nodeId: string): boolean => {
    const n = deps.log.state().nodes.find((x) => x.id === nodeId);
    return n !== undefined && DELIVERABLE.has(n.state);
  };
  return {
    available: known,
    availableAfter: (nodeId, next) =>
      deps.log.state().nodes.some((x) => x.id === nodeId) && DELIVERABLE.has(next),
    async deliver(nodeId, _text, instructedSeq) {
      if (!known(nodeId)) {
        return {
          ok: false,
          error: failure(
            "noRuntime",
            `ノード ${nodeId} は、動作中でも判断待ちでもない（知らせを出せない）`,
            "ノードの状態を確認する",
          ),
        };
      }
      let sent = sentByLog.get(deps.log);
      if (sent === undefined) {
        sent = new Set();
        sentByLog.set(deps.log, sent);
      }
      sent.add(instructedSeq);
      return { ok: true, value: undefined };
    },
  };
}
