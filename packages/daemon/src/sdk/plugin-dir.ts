/**
 * 子に付ける plugin の場所の確かめ（設計 6.2）。
 *
 * 親の mcp が `CLAUDE_PLUGIN_ROOT` を `parent_request` に添え、daemon が、起動の文に `--plugin-dir '<場所>'` を足す。
 * 次を満たさなければ付けず、理由（値・パスは入れない）を返す。
 * - 絶対パス。`..` の区切りがない。
 * - 実パス（realpath）にできる。確かめと起動の文には、実パスを使う（間のリンクの差し替えを防ぐ）。
 * - 実パスが、作業ツリー・リポジトリ・状態の置き場・touryou の置き場（`forbiddenRoots`）の中でない
 *   （作業ツリーに偽の plugin を作って指し、子に読ませるのを防ぐ）。
 * - 1 重の引用符で安全にくくれる（`'`・制御文字・行の区切りがない）。
 * - そこに `.claude-plugin/plugin.json` があり、`name` が touryou の plugin の名前と一致する。
 */

import { PLUGIN_NAME } from "@touryou/core";

export type PluginDirCheck =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly reason: string };

export interface PluginDirPorts {
  readonly readFile: (path: string) => string;
  readonly realpath: (path: string) => string;
  /** 中を指してはいけない場所。確かめのたびに realpath にし直す（できなければ元のパスで比べる）。 */
  readonly forbiddenRoots: readonly string[];
  /** 大文字小文字を区別しないファイルシステム（darwin・win32）の想定で、比べるときに両方を小文字にそろえる。 */
  readonly foldCase?: boolean;
}

/** `'` と制御文字（C0・DEL・C1）と、行・段落の区切り。 */
const UNQUOTABLE = /['\p{Cc}\p{Zl}\p{Zp}]/u;

const isUnder = (p: string, root: string, fold: boolean): boolean => {
  const f = (x: string) => (fold ? x.normalize("NFC").toLowerCase() : x);
  const r = f(root.replace(/\/+$/, ""));
  const q = f(p);
  return r === "" || q === r || q.startsWith(`${r}/`);
};

const realOr = (realpath: (p: string) => string, p: string): string => {
  try {
    return realpath(p);
  } catch {
    return p;
  }
};

export function checkPluginDir(given: string, ports: PluginDirPorts): PluginDirCheck {
  if (!given.startsWith("/")) return { ok: false, reason: "plugin の場所が絶対パスでない" };
  if (given.split("/").includes("..")) {
    return { ok: false, reason: "plugin の場所に .. の区切りがある" };
  }
  if (UNQUOTABLE.test(given)) {
    return { ok: false, reason: "plugin の場所に、コマンドに安全に書けない文字がある" };
  }
  let dir: string;
  try {
    dir = ports.realpath(given);
  } catch {
    return { ok: false, reason: "plugin の場所を実パスにできない" };
  }
  if (!dir.startsWith("/") || UNQUOTABLE.test(dir)) {
    return { ok: false, reason: "plugin の場所の実パスに、コマンドに安全に書けない文字がある" };
  }
  const fold = ports.foldCase === true;
  if (
    ports.forbiddenRoots.some(
      (r) => isUnder(dir, r, fold) || isUnder(dir, realOr(ports.realpath, r), fold),
    )
  ) {
    return {
      ok: false,
      reason: "plugin の場所が、作業ツリー・リポジトリ・状態の置き場・touryou の置き場の中にある",
    };
  }
  let text: string;
  try {
    text = ports.readFile(`${dir.replace(/\/+$/, "")}/.claude-plugin/plugin.json`);
  } catch {
    return { ok: false, reason: "plugin の場所に .claude-plugin/plugin.json が読めない" };
  }
  let name: unknown;
  try {
    name = (JSON.parse(text) as { name?: unknown }).name;
  } catch {
    return { ok: false, reason: "plugin の場所の plugin.json が JSON でない" };
  }
  if (name !== PLUGIN_NAME) {
    return { ok: false, reason: "plugin の場所の plugin.json の名前が touryou のものでない" };
  }
  return { ok: true, dir };
}
