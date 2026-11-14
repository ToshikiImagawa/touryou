/**
 * 子の作業ツリーの印（決定）。mcp の開き方を、起動したときの作業ディレクトリで決める。
 *
 * - daemon は、子の作業ツリーを作るとき、その作業ツリーの git のディレクトリ（`git rev-parse --absolute-git-dir`。追跡されない所）に、
 *   印のファイル `touryou-child`（中身はノードの ID だけ。秘密は入れない）を置く（`packages/daemon/src/git-ports.ts`）。
 *   childRuntime を問わず置く（Desktop の子の作業ツリーでも、mcp は紐付け待ちで開く）。
 * - mcp は、daemon にも git にも聞かずに、ファイルだけで決める（daemon に届かない・git がない・時間切れでも迷わない）:
 *   作業ディレクトリから上へ `.git` を探す。
 *   - `.git` がファイル（追加の作業ツリー・submodule）: 中身の `gitdir: <path>`（相対なら `.git` のファイルの場所から解く）の下の印を見る。
 *     印があれば紐付け待ち。なければ、さらに上を探す（子の作業ツリーの中の submodule で、根で開かないため）。
 *     `.git` が読めない・形が変なときは、紐付け待ちに倒す。
 *   - `.git` が symlink: 辿った先の種類で見る。
 *   - `.git` がディレクトリ（元のリポジトリ）: その下の印を見る（ふつうは、ない）。
 *   - 見つからない: 根で開く。
 *   印があるのに読めない・中身の形が変なときも、紐付け待ちに倒す（安全側）。
 * - 印は「誤りの防止」で、モデルに対する境界ではない（同じ OS ユーザーの子は、印を消せるし、root-token のファイルを直接読める。
 *   それはフックの範囲の判定で防ぐ）。
 * - 統合セッションが誤って紐付け待ちになったときは、人間が印を外す（`docs/plugin.md` の手順）。道具の呼び方で根に切り替える道はない。
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSafeId } from "@touryou/core";

/** `packages/daemon/src/git-ports.ts` の `CHILD_WORKTREE_MARKER` と同じ値。 */
export const CHILD_WORKTREE_MARKER = "touryou-child";

export type OpenMode =
  | { readonly kind: "root" }
  /** `nodeId`: 印に書かれた ID（読めない・形が変なら、なし）。 */
  | { readonly kind: "pending"; readonly nodeId?: string };

export interface MarkerOps {
  /** パスの種類（ない・ENOTDIR なら "none"。ほかの読めない理由は "unknown"）。 */
  readonly kindOf?: (path: string) => "file" | "dir" | "other" | "none" | "unknown";
  readonly read?: (path: string) => string;
}

const defaultKindOf = (path: string): "file" | "dir" | "other" | "none" | "unknown" => {
  try {
    let st = lstatSync(path);
    // symlink は辿ってから種類を見る（`.git` を symlink にしたリポジトリを、根として扱えるように）
    if (st.isSymbolicLink()) {
      try {
        st = statSync(path);
      } catch {
        // 壊れた symlink（辿れない）: 判断できないので紐付け待ちに倒す
        return "unknown";
      }
    }
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "none" : "unknown";
  }
};

const PENDING: OpenMode = { kind: "pending" };

/** 起動したときの作業ディレクトリから、開き方を決める。 */
export function detectOpenMode(cwd: string, ops: MarkerOps = {}): OpenMode {
  const kindOf = ops.kindOf ?? defaultKindOf;
  const read = ops.read ?? ((p: string) => readFileSync(p, "utf8"));
  const checkMarker = (gitDir: string): OpenMode => {
    const path = join(gitDir, CHILD_WORKTREE_MARKER);
    const k = kindOf(path);
    if (k === "none") return { kind: "root" };
    try {
      const text = read(path).trim();
      return isSafeId(text) ? { kind: "pending", nodeId: text } : PENDING;
    } catch {
      return PENDING;
    }
  };
  if (!isAbsolute(cwd)) return PENDING;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    const k = kindOf(dotGit);
    if (k === "dir") return checkMarker(dotGit);
    if (k === "file") {
      let text: string;
      try {
        text = read(dotGit);
      } catch {
        return PENDING;
      }
      const m = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(text);
      if (m === null || m[1] === undefined) return PENDING;
      const mode = checkMarker(isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]));
      // 印のない `.git` のファイル（子の作業ツリーの中の submodule など）では止まらず、さらに上を探す
      if (mode.kind === "pending") return mode;
    }
    // 読めない `.git`・ファイルでもディレクトリでもない `.git` は、判断できないので紐付け待ちに倒す
    if (k === "unknown" || k === "other") return PENDING;
    if (dirname(dir) === dir) return { kind: "root" };
  }
}
