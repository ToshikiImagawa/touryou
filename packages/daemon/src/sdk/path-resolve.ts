/**
 * 書き込み先のパスの実パス化（シンボリックリンク対策）。PRD: FR_014, NFR_016 / design 6.4, 9.2
 *
 * 書き込み先はまだ存在しないことがある。「最も深い既存の祖先」を `realpath` にして、残りの部分を結合する。
 * 存在しない部分に `..` があるもの、先が無いリンク（dangling）、その他の解決の失敗（権限など）は、例外にして
 * 呼び出し側（フック）が拒否する。外部（ファイルシステム）は `FsOps` に抽象化する。
 *
 * パスの形（`style`）は、`process.platform` から読まず、引数で受け取る（daemon が起動するときに 1 度だけ決める）。
 * 省略すると `posix`。Windows の形（`win`）は、core の path.ts の部品で根と要素に分ける。根（`C:\`・`\\srv\share`）
 * より上には行かない。Windows は `..` を、リンクをたどる前に字面で畳む（Win32 の決まり）ので、ここでも字面で畳む。
 * POSIX は、`..` を畳まずに OS の解決に任せる（リンクの先の親を指すことがあるため）。
 */

import { lstat, realpath } from "node:fs/promises";
import {
  type AbsPath,
  joinPath,
  type PathStyle,
  parsePath,
  type RelPath,
  toNative,
} from "@touryou/core";

export interface FsOps {
  realpath(path: string): Promise<string>;
  /** 存在しなければ `ENOENT`・`ENOTDIR` で reject する。リンクはたどらない。 */
  lstat(path: string): Promise<unknown>;
}

export const nodeFsOps: FsOps = { realpath, lstat };

const missing = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** `prefix` の実パス。存在しなければ `undefined`。先の無いリンク・そのほかの失敗は reject する。 */
async function realOrMissing(prefix: string, fs: FsOps): Promise<string | undefined> {
  try {
    return await fs.realpath(prefix);
  } catch (e) {
    if (!missing(e)) throw e;
    // 存在しない。ただし先の無いリンクなら、書き込みでリンク先が作られるため拒否する。
    try {
      await fs.lstat(prefix);
    } catch (e2) {
      if (!missing(e2)) throw e2;
      return undefined;
    }
    throw new Error(`先の無いリンク: ${prefix}`);
  }
}

/**
 * 信頼する側が決めたパス（作業ツリー・範囲の場所・フックの今の場所。どれも daemon か設定が決める）を、検査をせずに分ける。
 * 子が渡すパス（道具の入力）には使わない。作業ツリーの場所には、8.3 形式の短い名前（`RUNNER~1`）などが入ることがあり、
 * そこまで拒むと動かなくなるので、検査をしない口を分けてある。この関数のほかでは、検査をしない口を呼ばない。
 */
function parseTrusted(raw: string, style: PathStyle): AbsPath | RelPath {
  const p = parsePath(raw, style, { lenient: true });
  if (p.kind === "invalid") throw new Error("パスを分けられない");
  return p;
}

/** Windows の形で、根が決まった絶対パスか（`C:` か、共有の名前まである UNC）。 */
const hasWinRoot = (p: AbsPath): boolean =>
  /^[A-Za-z]:$/.test(p.root) || /^UNC\/[^/]+\/[^/]+$/.test(p.root);

/**
 * Windows の形で、`raw` を `base` を基準にした絶対パス（OS の形）にする。できなければ `undefined`。
 * - `base` は信頼する側のパス（作業ツリーなど）。検査をしない。
 * - `raw` は、`trusted` が真なら信頼する側のパス（範囲の場所）。偽なら子が渡したパスで、判定できない形（ドライブ相対・
 *   別名の形・予約デバイス名など）は `undefined`。
 */
export function winAbsolute(raw: string, base: string, trusted: boolean): string | undefined {
  const p = trusted ? parseTrusted(raw, "win") : parsePath(raw, "win");
  if (p.kind === "invalid") return undefined;
  if (p.kind === "abs") return hasWinRoot(p) ? toNative(p) : undefined;
  const b = parseTrusted(base, "win");
  return b.kind === "abs" && hasWinRoot(b) ? toNative(joinPath(b, p)) : undefined;
}

/** 絶対パスを、最も深い既存の祖先の実パス＋残りにする。解決できなければ reject する。 */
export async function resolveForWrite(
  absPath: string,
  fs: FsOps,
  style: PathStyle = "posix",
): Promise<string> {
  if (absPath.includes("\0")) throw new Error("絶対パスでない");
  if (style === "win") return resolveWin(absPath, fs);
  if (!absPath.startsWith("/")) throw new Error("絶対パスでない");
  const segments = absPath.split("/").filter((s) => s !== "" && s !== ".");
  for (let i = segments.length; i >= 0; i--) {
    const real = await realOrMissing(`/${segments.slice(0, i).join("/")}`, fs);
    if (real === undefined) continue;
    const rest = segments.slice(i);
    if (rest.includes("..")) throw new Error("存在しない部分に .. がある");
    return rest.length === 0 ? real : `${real === "/" ? "" : real}/${rest.join("/")}`;
  }
  throw new Error("解決できるパスがない");
}

/**
 * Windows の形。渡されるのは、呼ぶ側が絶対パスにしたもの（`winAbsolute` の結果か、信頼する側のパス）なので、検査をせずに分ける。
 * 子が渡したパスの検査は、絶対パスにする所（`winAbsolute`）と、範囲の判定（core の `evaluateScope`）で行う。
 */
async function resolveWin(absPath: string, fs: FsOps): Promise<string> {
  const p = parseTrusted(absPath, "win");
  if (p.kind !== "abs" || !hasWinRoot(p)) throw new Error("絶対パスでない");
  for (let i = p.segments.length; i >= 0; i--) {
    const real = await realOrMissing(toNative({ ...p, segments: p.segments.slice(0, i) }), fs);
    if (real === undefined) continue;
    const rest = p.segments.slice(i);
    return rest.length === 0 ? real : `${real.replace(/[\\/]+$/, "")}\\${rest.join("\\")}`;
  }
  throw new Error("解決できるパスがない");
}
