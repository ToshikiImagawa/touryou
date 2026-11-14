/**
 * `@touryou/core/fs`: 秘密・置き場のファイルの確かめ（OS の道具。mcp・cli・daemon が使う）。core の本体（`@touryou/core`）からは読み込まない
 * （本体は node: に依存しない）。
 *
 * ACL の確かめ（`modeString` をここへ移した）:
 * - `fstat` の mode ビットは ACL を映さない。ACL があると、mode が 0600 でも他の人が読める・書ける。
 * - macOS の `ls -l` は、拡張属性（`@`）があると ACL の印（`+`）を出さない（`@` が優先）。そのため macOS では `ls -ldei` で ACL の行
 *   （` 0: ...`）を数え、あれば `+` を末尾に足す。Linux は `ls -ldi` の `+`（POSIX ACL）を見る。`.`（SELinux の文脈）・`@` は可。
 * - `/bin/ls` を、`LC_ALL=C`・`PATH=/bin:/usr/bin`・時間切れ（2 秒。過ぎたら SIGKILL）で呼び、引数の前に `--` を付ける。
 *   失敗した・時間切れ・シグナルで終わった・出力が想定外のときは、分からないので拒む。
 * - 開いた fd を渡すと、`ls -i` の inode と `fstat` の inode を照らす（パスが差し替えられていれば拒む）。照らしが通ったものは、
 *   (dev, ino, ctimeNs, mode, uid) を鍵にして覚え、次からは `ls` を起こさない（ACL を付け替えると ctime が変わる）。
 *
 * 限界（前から）: Linux の NFSv4 ACL は `ls` に `+` が出ないので、見落とす。Windows（win32）は対象外で、全部拒む。
 */
import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** `ls` を呼んだ結果。 */
export interface LsResult {
  readonly status: number | null;
  readonly signal?: string | null;
  readonly error?: Error;
  readonly stdout: string;
}
/** `ls` を呼ぶ（試験で差し替える）。 */
export type LsRunner = (args: readonly string[]) => LsResult;

/** `ls` の時間切れ（ms）。NFS・FUSE・壊れた automount で止まっても、ここで打ち切って拒む。 */
export const LS_TIMEOUT_MS = 2000;

/** `ls` を呼ぶ道具を作る（既定は `/bin/ls`。試験で、止まるコマンドと短い時間切れを渡す）。 */
export function createLsRunner(
  opts: { readonly command?: string; readonly timeoutMs?: number } = {},
): LsRunner {
  return (args) => {
    const r = spawnSync(opts.command ?? "/bin/ls", [...args], {
      encoding: "utf8",
      env: { LC_ALL: "C", PATH: "/bin:/usr/bin" },
      timeout: opts.timeoutMs ?? LS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    return {
      status: r.status,
      signal: r.signal,
      ...(r.error === undefined ? {} : { error: r.error }),
      stdout: typeof r.stdout === "string" ? r.stdout : "",
    };
  };
}
const defaultLs = createLsRunner();

export interface AclOps {
  readonly run?: LsRunner;
  /** 既定は `process.platform`。 */
  readonly platform?: NodeJS.Platform;
  /** 開いた fd（あれば、inode を照らし、通ったものを覚える）。 */
  readonly fd?: number;
}

interface LsLine {
  readonly ino: string;
  readonly mode: string;
}

function lsLine(path: string, ops: AclOps): LsLine | undefined {
  const platform = ops.platform ?? process.platform;
  if (platform === "win32") return undefined;
  const mac = platform === "darwin";
  let r: LsResult;
  try {
    r = (ops.run ?? defaultLs)([mac ? "-ldei" : "-ldi", "--", path]);
  } catch {
    return undefined;
  }
  if (r.error !== undefined || (r.signal ?? null) !== null || r.status !== 0) return undefined;
  const [first = "", ...rest] = r.stdout.split("\n");
  const cols = first.trimStart().split(/\s+/);
  const ino = cols[0] ?? "";
  const mode = cols[1] ?? "";
  if (!/^[0-9]+$/.test(ino) || mode === "") return undefined;
  const hasAcl = mac && rest.some((line) => /^\s*\d+:/.test(line));
  return { ino, mode: hasAcl && !mode.endsWith("+") ? `${mode}+` : mode };
}

/**
 * `ls -ld` の 1 列目（権限の文字列。ACL・拡張属性の印を含む）。macOS で ACL の行があれば、末尾に `+` を足す。
 * `ls` が失敗した・時間切れ・出力が想定外なら `undefined`。
 */
export function modeString(path: string, ops: AclOps = {}): string | undefined {
  return lsLine(path, ops)?.mode;
}

/** 権限の文字列の形（種類 1 文字・権限 9 文字・印）。 */
const MODE_RE = /^[-dlbcps][-rwxsStT]{9}([@+.]*)$/;

/** 権限の文字列を分ける。`plain`: ACL なし。`acl`: ACL あり。`unknown`: 読めない・形が想定外（拒む）。 */
export function classifyMode(mode: string | undefined): "plain" | "acl" | "unknown" {
  if (mode === undefined) return "unknown";
  const m = MODE_RE.exec(mode);
  if (m === null) return "unknown";
  return (m[1] ?? "").includes("+") ? "acl" : "plain";
}

/** 権限の文字列から、ACL の問題の理由（`modeString` を差し替える箇所が使う）。問題がなければ `undefined`。 */
export function aclProblemOfMode(mode: string | undefined): string | undefined {
  switch (classifyMode(mode)) {
    case "plain":
      return undefined;
    case "acl":
      return "ACL が付いている（chmod -N で外す）";
    default:
      return "ACL を確かめられない（ls が失敗した・時間切れ・出力が想定外）";
  }
}

/** 照らしが通ったもの（鍵: dev:ino:ctimeNs:mode:uid）。大きくなりすぎたら空にする。 */
const verified = new Set<string>();
const CACHE_MAX = 1024;
/** 試験用: 覚えたものを忘れる。 */
export function clearAclCache(): void {
  verified.clear();
}

/** ACL が付いている・確かめられないなら、理由を返す（分からないときは拒む）。 */
export function aclProblem(path: string, ops: AclOps = {}): string | undefined {
  let key: string | undefined;
  let ino: bigint | undefined;
  if (ops.fd !== undefined) {
    try {
      const st = fstatSync(ops.fd, { bigint: true });
      ino = st.ino;
      key = `${st.dev}:${st.ino}:${st.ctimeNs}:${st.mode}:${st.uid}`;
    } catch {
      return "ACL を確かめられない（開いたファイルを fstat できない）";
    }
    if (verified.has(key)) return undefined;
  }
  const line = lsLine(path, ops);
  const why = aclProblemOfMode(line?.mode);
  if (why !== undefined) return why;
  if (ino !== undefined && line?.ino !== ino.toString()) {
    return "ACL を確かめられない（確かめたものと、開いたものが違う）";
  }
  if (key !== undefined) {
    if (verified.size >= CACHE_MAX) verified.clear();
    verified.add(key);
  }
  return undefined;
}

/** ACL の確かめ。問題がなければ `undefined`、あれば理由（拒む）。`fd` は開いたもの（あれば、inode を照らす）。 */
export type AclCheck = (path: string, fd?: number) => string | undefined;

/** 既定の確かめ（本物の `/bin/ls`）。 */
export const defaultAclCheck: AclCheck = (path, fd) =>
  aclProblem(path, fd === undefined ? {} : { fd });

/** 秘密のファイルを読めなかった理由（`code` は短い記号。内容は含めない）。 */
export class SecureFileError extends Error {
  constructor(
    readonly code: "missing" | "link" | "notFile" | "owner" | "mode" | "size" | "acl" | "io",
    message: string,
  ) {
    super(message);
  }
}

export interface SecureReadOptions {
  /** 立っていてはいけない権限のビット（例: 0o077・0o022）。 */
  readonly forbid: number;
  readonly maxBytes: number;
  /** 自分の uid（既定は `process.getuid()`。`undefined` なら持ち主は見ない）。 */
  readonly uid?: number | undefined;
  readonly acl?: AclCheck;
}

/**
 * 秘密のファイルを安全に読む。`O_NOFOLLOW`（リンクは開かない）・`O_NONBLOCK`（FIFO で止まらない）で開き、開いた fd の `fstat` で、
 * 通常のファイル・持ち主が自分・`forbid` のビットがない・大きさの上限を確かめ、ACL を（fd と照らして）確かめてから、fd から読む。
 */
export function readSecureFile(path: string, opts: SecureReadOptions): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SecureFileError("missing", "ない");
    if (code === "ELOOP") throw new SecureFileError("link", "リンクになっている");
    throw new SecureFileError("io", `開けない（${String(code)}）`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SecureFileError("notFile", "通常のファイルでない");
    const uid = "uid" in opts ? opts.uid : process.getuid?.();
    if (uid !== undefined && st.uid !== uid)
      throw new SecureFileError("owner", "持ち主が自分でない");
    if ((st.mode & opts.forbid) !== 0) {
      throw new SecureFileError("mode", `権限が緩い（${(st.mode & 0o777).toString(8)}）`);
    }
    if (st.size > opts.maxBytes) throw new SecureFileError("size", "大きすぎる");
    const why = (opts.acl ?? defaultAclCheck)(path, fd);
    if (why !== undefined) throw new SecureFileError("acl", why);
    const buf = Buffer.alloc(opts.maxBytes + 1);
    let off = 0;
    for (;;) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
      if (off > opts.maxBytes) throw new SecureFileError("size", "大きすぎる");
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
