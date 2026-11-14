/**
 * 自分のセッションの受信箱のソケットに、知らせを 1 行書く（設計 6.3）。書く形が版で変わっても、ここだけを直す。
 *
 * 書く形は、公式の文書（code.claude.com の cross-session-messaging「The session's inbox socket」）による:
 * - ソケットの場所は `CLAUDE_CODE_MESSAGING_SOCKET`（macOS・Linux は Unix ドメインソケット。Windows は名前付きパイプ）。
 * - 接続の最初の行に `{"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}` を送れる（macOS・Linux は任意、Windows は必須）。
 *   コンテナで Claude Code が PID 1 のときや、macOS で書いたプロセスが終わったあとは、このトークンで「自分の子」と確かめられるので、
 *   トークンがあれば、いつも付ける。
 * - 本文は、続けて 1 行の JSON `{"type":"user","message":{"role":"user","content":"<本文>"}}`（改行で終わる）。公式の文書には行の形が
 *   書かれていないので、Claude Code の `--debug` の案内（`[uds-messaging] Inject messages`）に合わせる。平文の行は
 *   「Failed to parse JSON line」で捨てられる。
 * - 接続から 30 秒以内に、完全な行を送らない接続は閉じられる。ここでは、中身を作ってから接続し、`WRITE_TIMEOUT_MS` で打ち切る。
 *
 * 知らせは「番の区切り」で届く（番の最中に書いたものは、その番のあと）。中身はいつも受信箱に置き、ここには 1 行だけを書く。
 * トークンは、ログ・失敗の原因に出さない。
 */
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";

/** 書き終えるまでの上限（公式の 30 秒より短く）。 */
export const WRITE_TIMEOUT_MS = 20_000;

/** 知らせの本文（1 行）。番号は、記録の seq（返事と出来事を結びつける）。 */
export const notificationText = (seq: number, childIds: readonly string[] = []): string => {
  // 送り手（直接の子のノード）を付ける。長くならないよう、3 つまでにして、残りは件数だけにする。
  const shown = childIds.slice(0, MAX_SHOWN_CHILDREN).map((id) => id.slice(0, 64));
  const rest = childIds.length - shown.length;
  const from =
    shown.length === 0 ? "" : `。ノード ${shown.join("、")}${rest > 0 ? ` ほか ${rest} 件` : ""}`;
  return `touryou の受信箱（inbox_fetch）を読んで、書かれた手順に従って（番号 ${seq}${from}）`;
};
/** 知らせに書く、送り手のノードの数の上限。 */
export const MAX_SHOWN_CHILDREN = 3;

export type NotifyResult =
  | { readonly written: true }
  | {
      readonly written: false;
      readonly reason: "noSocket" | "timeout" | "error";
      readonly cause?: string;
    };

export interface NotifyDeps {
  readonly connect?: (path: string) => Socket;
  readonly exists?: (path: string) => boolean;
  readonly timeoutMs?: number;
}

/** 環境変数から、書き先を読む。ソケットがなければ `undefined`（書かない）。 */
export const socketFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): { readonly path: string; readonly token?: string } | undefined => {
  const path = env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (path === undefined || path === "") return undefined;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  return token === undefined || token === "" ? { path } : { path, token };
};

/** 書く中身（auth の行と、本文の JSON 1 行）。本文の改行は空白にする（知らせは 1 行）。 */
export const framesOf = (text: string, token?: string): string =>
  `${token === undefined ? "" : `${JSON.stringify({ type: "auth", token })}\n`}${JSON.stringify({
    type: "user",
    message: { role: "user", content: text.replace(/[\r\n]+/g, " ") },
  })}\n`;

export function writeNotification(
  target: { readonly path: string; readonly token?: string } | undefined,
  text: string,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  if (target === undefined) return Promise.resolve({ written: false, reason: "noSocket" });
  const exists = deps.exists ?? existsSync;
  // Windows の名前付きパイプ（\\.\pipe\...）は、存在の確かめをしない。
  if (!target.path.startsWith("\\\\") && !exists(target.path)) {
    return Promise.resolve({ written: false, reason: "noSocket" });
  }
  const payload = framesOf(text, target.token);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: NotifyResult, sock?: Socket): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock?.destroy();
      resolve(r);
    };
    const sock = (deps.connect ?? ((p: string) => createConnection(p)))(target.path);
    const timer = setTimeout(
      () => done({ written: false, reason: "timeout" }, sock),
      deps.timeoutMs ?? WRITE_TIMEOUT_MS,
    );
    timer.unref?.();
    sock.on("error", (e: NodeJS.ErrnoException) => {
      const reason = e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "noSocket" : "error";
      done({ written: false, reason, cause: e.code ?? "error" }, sock);
    });
    sock.on("connect", () => {
      sock.end(payload, () => done({ written: true }, sock));
    });
  });
}
