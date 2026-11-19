/**
 * パスの部品（純粋関数。ファイルには触れない）。範囲の判定（scope.ts）と、daemon のフックの判定が、同じ規則で
 * パスを分け・つなぎ・比べるために使う。PRD: FR_014, NFR_016
 *
 * - `style` は `"posix"`（macOS・Linux）か `"win"`（Windows）。`process.platform` は読まず、呼ぶ側が渡す
 *   （どの OS のテストでも、両方の形を確かめられる）。
 * - 比べる用の形は POSIX の形にそろえる（`C:\a\b` → `/C:/a/b`、`\\srv\share\a` → `/UNC/srv/share/a`）。
 * - `..` は根（`/`・`C:`・`UNC/srv/share`）より上には行かない（Windows は根で止まる。越えて畳むと、別のドライブや
 *   別の共有を指す形に化ける）。
 * - `parsePath` は、既定では厳しく見る（判定の対象のパス用）。Windows の形では、別の名前が同じものを指す形と
 *   予約デバイス名を `invalid` にする。`lenient: true` は、設定の場所や作業ツリーのように、信頼する側が決めた
 *   パスを比べる形にするときに使う（どんな文字列でも分ける）。
 */

export type PathStyle = "posix" | "win";

export type PathInvalidReason =
  | "empty"
  | "nul"
  | "formatChar" // 書式制御文字（Cf）。HFS+ が無視して別名と同一視する
  | "device" // `\\?\`・`\\.\`（正規化を通らない形・デバイス）
  | "rootRelative" // `\foo`・`/foo`（Windows。どのドライブかが決まらない）
  | "driveRelative" // `C:foo`（Windows。そのドライブの今の場所が基準）
  | "stream" // `file:stream`（代替データストリーム）
  | "alias" // 要素の末尾の `.`・空白、8.3 形式の短い名前（`SECRET~1`）
  | "reservedName" // `NUL`・`CON`・`COM1` など（拡張子付きを含む）
  | "incompleteUnc"; // `\\srv` だけ（共有の名前がない）

export interface AbsPath {
  readonly kind: "abs";
  readonly style: PathStyle;
  /** 根。POSIX は空文字、Windows は `C:` か `UNC/srv/share`（`lenient` のときだけ、決まらない根として空文字もある）。 */
  readonly root: string;
  /** 根より下の要素（`.`・`..` は畳んである）。 */
  readonly segments: readonly string[];
}

export interface RelPath {
  readonly kind: "rel";
  readonly style: PathStyle;
  /** 要素（`.` は除く。`..` は残る。つなぐときに畳む）。 */
  readonly segments: readonly string[];
}

export type ParsedPath =
  | AbsPath
  | RelPath
  | { readonly kind: "invalid"; readonly reason: PathInvalidReason };

/** Windows の絶対パス（`C:\...`・`C:/...`・`\\server\share\...`）か。 */
export const isWinAbs = (path: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");

/** 絶対パスか（POSIX の `/...` か、Windows の絶対パス）。 */
export const isAbsolutePath = (path: string): boolean => path.startsWith("/") || isWinAbs(path);

/** パスの形から style を決める（Windows の絶対パスなら `win`）。style を受け取れない古い口のためのもの。 */
export const styleOfPath = (path: string): PathStyle => (isWinAbs(path) ? "win" : "posix");

/** 場所の比較用。大文字小文字と Unicode の正規形の違いを畳み込む。表示・記録には使わない。 */
export const foldPath = (path: string): string =>
  path.normalize("NFC").toLowerCase().normalize("NFC");

export const hasNul = (s: string): boolean => s.includes("\0");

/** 書式制御文字（Cf）。ゼロ幅文字など、一部のファイルシステム（HFS+）が無視するため名前の比較を迂回できる。 */
export const hasFormatChar = (s: string): boolean => /\p{Cf}/u.test(s);

/**
 * Windows の絶対パスを、POSIX の形に読み替える（`C:\a\b` → `/C:/a/b`、`\\srv\share\a` → `/UNC/srv/share/a`）。
 * 比べるための形で、ファイルを開くのには使わない。Windows の絶対パスでなければ、そのまま返す。
 */
export function posixForm(raw: string): string {
  if (!isWinAbs(raw)) return raw;
  // `\\?\C:\a` は `C:\a`、`\\?\UNC\srv\share` は `\\srv\share` と同じものを指す
  const path = raw.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, "\\\\").replace(/^[\\/]{2}\?[\\/]/, "");
  const s = path.replace(/\\/g, "/");
  return s.startsWith("//") ? `/UNC/${s.replace(/^\/+/, "")}` : `/${s}`;
}

/**
 * Windows の予約デバイス名か（要素 1 つを見る）。拡張子や末尾の空白が付いても、同じデバイスを指す
 * （`NUL.txt`・`con .log`）。`COM¹` のような上付きの数字も含む。
 */
export function isReservedWinName(segment: string): boolean {
  const base = (segment.split(".")[0] ?? "").replace(/ +$/, "");
  return /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³])$/i.test(base);
}

/**
 * Windows の形のパスが、判定できない形か。問題がなければ `undefined`。
 * - `\\?\`・`\\.\`（正規化を通らない形・デバイス。`\\?\` の中では `..` も字面のままなので、畳んだ結果が OS とずれる）
 * - `\foo`・`/foo`（区切り 1 つで始まる。今のドライブの根が基準で、どのドライブかが決まらない）
 * - `C:foo`（ドライブ相対。そのドライブの今の場所が基準で、作業ツリーとは関係がない）
 * - `:`（ドライブ文字の後のほか。代替データストリーム `file:stream`）
 * - 要素の末尾の `.`・空白（Win32 は取り除く。`secret.` は `secret` と同じ）、`~<数字>`（8.3 形式の短い名前）
 * - 予約デバイス名（`NUL`・`CON`・`COM1` など）
 */
export function winPathProblem(path: string): PathInvalidReason | undefined {
  if (/^[\\/]{2}[?.][\\/]/.test(path)) return "device";
  if (/^[\\/](?![\\/])/.test(path)) return "rootRelative";
  if (/^[A-Za-z]:(?![\\/])/.test(path)) return "driveRelative";
  // ドライブ文字を外すのは、後ろに区切りが続くとき（絶対パス）だけ
  const rest = path.replace(/^[A-Za-z]:(?=[\\/])/, "");
  if (rest.includes(":")) return "stream";
  const segs = rest.split(/[\\/]/).filter((seg) => seg !== "." && seg !== "..");
  if (segs.some((seg) => /[. ]$/.test(seg) || /~\d/.test(seg))) return "alias";
  if (segs.some(isReservedWinName)) return "reservedName";
  return undefined;
}

/** 生のパスを、区切りで分ける（畳まない）。`abs` は、根から始まるか。 */
function tokens(raw: string, style: PathStyle): { abs: boolean; parts: string[] } {
  const s = isWinAbs(raw) ? posixForm(raw) : style === "win" ? raw.replace(/\\/g, "/") : raw;
  return { abs: s.startsWith("/"), parts: s.split("/") };
}

/** 根に当たる要素の数（`parts` は、根から並べた要素）。POSIX は 0、Windows は `C:` が 1、`UNC/srv/share` が 3。 */
function rootLength(parts: readonly string[], style: PathStyle): number {
  if (style !== "win") return 0;
  if (/^[A-Za-z]:$/.test(parts[0] ?? "")) return 1;
  return parts[0] === "UNC" ? 3 : 0;
}

/** 空の要素と `.` を捨て、`..` を畳む。根より上には行かない。 */
function collapse(parts: readonly string[], style: PathStyle): string[] {
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > rootLength(out, style)) out.pop();
    } else out.push(seg);
  }
  return out;
}

/**
 * `cwd` を基準に絶対化し、`.` と `..` を畳んだ、POSIX の形の文字列を返す（大文字小文字は畳まない。記録にも使う）。
 * どんな文字列でも返す（検査はしない。判定の対象のパスは、先に `parsePath` か `winPathProblem` で確かめる）。
 * `style` が `win` のときは、相対パスの `\` も区切りとして扱う。
 */
export function resolvePosixForm(cwd: string, path: string, style: PathStyle): string {
  const p = tokens(path, style);
  const parts = p.abs ? p.parts : [...tokens(cwd, style).parts, ...p.parts];
  return `/${collapse(parts, style).join("/")}`;
}

/**
 * POSIX の形の文字列どうしで、`path` が `dir` と同じか、その下にあるか（大文字小文字と正規形の違いは畳む）。
 * Windows の絶対パスは、POSIX の形に読み替えてから比べる。`.`・`..` は畳まない（畳んだものを渡す）。
 */
export function isUnderForm(path: string, dir: string): boolean {
  // 末尾の区切りは外して比べる（`C:\` は `/C:`、`/` は空になる。空は、すべてを含む根）
  const p = foldPath(posixForm(path)).replace(/\/+$/, "");
  const d = foldPath(posixForm(dir)).replace(/\/+$/, "");
  return d === "" || p === d || p.startsWith(`${d}/`);
}

/**
 * 生のパスを、絶対パス・相対パス・不正に分ける。
 * 既定（厳しい）: 空・NUL・書式制御文字を不正にする。`style` が `win` のときは、`winPathProblem` の形と、共有の名前の
 * ない UNC も不正にする。`//srv/share` も UNC として扱う。
 * `lenient: true`: 検査をせず、どんな文字列でも分ける（`\\?\C:\a` は `C:\a` に読み替える。`win` で区切り 1 つで始まる
 * ものは、根の決まらない絶対パスになる）。
 */
export function parsePath(
  raw: string,
  style: PathStyle,
  opts: { readonly lenient?: boolean } = {},
): ParsedPath {
  const strict = opts.lenient !== true;
  let input = raw;
  if (strict) {
    if (raw.trim() === "") return { kind: "invalid", reason: "empty" };
    if (hasNul(raw)) return { kind: "invalid", reason: "nul" };
    if (hasFormatChar(raw)) return { kind: "invalid", reason: "formatChar" };
    if (style === "win") {
      const problem = winPathProblem(raw);
      if (problem !== undefined) return { kind: "invalid", reason: problem };
      // `//srv/share` も、Windows では UNC
      if (/^[\\/]{2}/.test(raw)) input = `\\\\${raw.slice(2)}`;
    }
  }
  const t = tokens(input, style);
  if (!t.abs) {
    return { kind: "rel", style, segments: t.parts.filter((s) => s !== "" && s !== ".") };
  }
  const parts = collapse(t.parts, style);
  const n = Math.min(rootLength(parts, style), parts.length);
  if (strict && style === "win" && (n === 0 || (parts[0] === "UNC" && n < 3))) {
    return { kind: "invalid", reason: n === 0 ? "rootRelative" : "incompleteUnc" };
  }
  return { kind: "abs", style, root: parts.slice(0, n).join("/"), segments: parts.slice(n) };
}

/** `base` に `rel` をつなぐ。`rel` が絶対パスなら、そのまま返す。`..` は根より上には行かない。 */
export function joinPath(base: AbsPath, rel: AbsPath | RelPath): AbsPath {
  if (rel.kind === "abs") return rel;
  const segments = [...base.segments];
  for (const seg of rel.segments) {
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return { ...base, segments };
}

/** POSIX の形の文字列（`/a/b`・`/C:/a/b`・`/UNC/srv/share/a`）。大文字小文字は畳まない（記録・表示用）。 */
export function toPosixForm(p: AbsPath): string {
  return `/${[...(p.root === "" ? [] : [p.root]), ...p.segments].join("/")}`;
}

/** 比べる用の形（`toPosixForm` を、大文字小文字と正規形で畳んだもの）。表示・記録・ファイルを開くのには使わない。 */
export const toCanonical = (p: AbsPath): string => foldPath(toPosixForm(p));

/** ファイルの API に渡す形（POSIX は `/a/b`、Windows は `C:\a\b`・`\\srv\share\a`）。 */
export function toNative(p: AbsPath): string {
  if (p.style !== "win") return toPosixForm(p);
  const rest = p.segments.join("\\");
  if (p.root.startsWith("UNC/")) {
    const root = `\\\\${p.root.slice("UNC/".length).replace(/\//g, "\\")}`;
    return rest === "" ? root : `${root}\\${rest}`;
  }
  return `${p.root}\\${rest}`;
}

/** `child` が `dir` と同じか、その下にあるか（根と区切りを正しく扱い、大文字小文字と正規形の違いは畳む）。 */
export function isUnderPath(child: AbsPath, dir: AbsPath): boolean {
  const c = [...(child.root === "" ? [] : [child.root]), ...child.segments].map(foldPath);
  const d = [...(dir.root === "" ? [] : [dir.root]), ...dir.segments].map(foldPath);
  return d.length <= c.length && d.every((seg, i) => seg === c[i]);
}
