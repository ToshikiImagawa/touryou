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
 * 限界（前から）: Linux の NFSv4 ACL は `ls` に `+` が出ないので、見落とす。
 *
 * Windows（win32）:
 * - `fstat` の mode・uid は、権限を映さない（mode はいつも 0666、uid は 0）。mode と持ち主の確かめは意味がないので、
 *   `permMode`・`ownUid` で POSIX の「締まった値」に読み替え、守りは ACL の確かめ（DACL）にすべて任せる。
 * - `icacls <path> /save <一時ファイル>` で DACL を SDDL の形で取る（名前でなく SID で出るので、OS の言語に依存しない）。
 *   許可（allow）の ACE の相手が、自分・SYSTEM・Administrators・CREATOR OWNER・OWNER RIGHTS だけなら通す。
 *   `noWrite`（POSIX の 0o022 に当たる）では、ほかの相手の「読む・実行する」だけの許可は通す。
 * - 自分の SID は `whoami /user` で 1 回だけ取る。取れない・`icacls` が失敗した・時間切れ・SDDL が想定外のときは、拒む。
 * - 開いた fd を渡すと、`fstat` の inode と、パスの `lstat` の inode を照らす。
 * - 限界: 持ち主（owner）は確かめない（`icacls /save` の SDDL に入らない）。持ち主が他人だと、その人は DACL を書き換えられる。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

/**
 * ACL の確かめの厳しさ（Windows だけで使う。POSIX では mode ビットを別に確かめる）。
 * `private`: ほかの人に何の許可もない（0o077 に当たる）。`noWrite`: ほかの人は読む・実行するだけ（0o022 に当たる）。
 */
export type AclLevel = "private" | "noWrite";

/** `forbid` のビット（0o077・0o022 など）から、厳しさを決める（読む許可を禁じるなら `private`）。 */
export const aclLevelOf = (forbid: number): AclLevel =>
  (forbid & 0o044) !== 0 ? "private" : "noWrite";

/** Windows の ACL を取る道具（試験で差し替える）。 */
export interface WinAclRunner {
  /** パスの DACL の SDDL（`D:...`）。取れなければ `undefined`。 */
  readonly sddl: (path: string) => string | undefined;
  /** 自分の SID（`S-1-5-21-...`）。取れなければ `undefined`。 */
  readonly selfSid: () => string | undefined;
}

export interface AclOps {
  readonly run?: LsRunner;
  /** 既定は `process.platform`。 */
  readonly platform?: NodeJS.Platform;
  /** 開いた fd（あれば、inode を照らし、通ったものを覚える）。 */
  readonly fd?: number;
  /** Windows の確かめの厳しさ（既定は `private`）。 */
  readonly level?: AclLevel;
  /** Windows の ACL を取る道具（既定は `icacls`・`whoami`）。 */
  readonly win?: WinAclRunner;
}

const winTool = (name: string): string =>
  join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

let cachedSelfSid: string | undefined;

/** 既定の道具（`icacls /save` と `whoami /user`）。 */
export const defaultWinAcl: WinAclRunner = {
  sddl: (path) => {
    const full = resolve(path);
    // icacls は `*`・`?` を展開し、要素の末尾の `.`・空白を取り除く（Node が開くのとは別のファイルを見る）。確かめられないとして拒む
    if (/[*?]/.test(full) || full.split(/[\\/]/).some((seg) => /[. ]$/.test(seg))) return undefined;
    const out = join(tmpdir(), `touryou-acl-${process.pid}-${randomBytes(8).toString("hex")}.txt`);
    try {
      const r = spawnSync(winTool("icacls.exe"), [full, "/save", out], {
        encoding: "utf8",
        timeout: LS_TIMEOUT_MS,
        windowsHide: true,
      });
      if (r.error !== undefined || r.signal !== null || r.status !== 0) return undefined;
      // 1 行目は名前、2 行目が SDDL（UTF-16LE。先頭に BOM）
      const lines = readFileSync(out, "utf16le")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/);
      const sddl = lines[1];
      return sddl?.startsWith("D:") ? sddl : undefined;
    } catch {
      return undefined;
    } finally {
      rmSync(out, { force: true });
    }
  },
  selfSid: () => {
    if (cachedSelfSid !== undefined) return cachedSelfSid;
    try {
      const r = spawnSync(winTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
        encoding: "utf8",
        timeout: LS_TIMEOUT_MS,
        windowsHide: true,
      });
      if (r.error !== undefined || r.status !== 0) return undefined;
      const m = /"(S-1-[0-9-]+)"\s*$/.exec(String(r.stdout).trim());
      cachedSelfSid = m?.[1];
      return cachedSelfSid;
    } catch {
      return undefined;
    }
  },
};

/**
 * いつも許す相手（SYSTEM・Administrators・CREATOR OWNER）。SDDL の別名と SID の両方。
 * CREATOR OWNER は、継承のひな形で、そのもの自体には誰にも当たらない。
 * OWNER RIGHTS（`OW`）は入れない（持ち主が自分とは限らない。持ち主は確かめていない）。
 */
const WIN_TRUSTED = new Set(["SY", "BA", "CO", "S-1-5-18", "S-1-5-32-544", "S-1-3-0"]);
/** 「読む・実行する」だけの権利（FILE_GENERIC_READ | FILE_GENERIC_EXECUTE）。 */
const WIN_READ_MASK = 0x1200a9;
const WIN_READ_CODES = new Set(["FR", "FX", "GR", "GX"]);

function winRightsReadOnly(rights: string): boolean {
  // 権利は 32 ビット。それより長い 16 進は、ビット演算で上の桁が落ちるので拒む
  if (/^0x[0-9a-f]+$/i.test(rights)) {
    return rights.length <= 10 && (Number.parseInt(rights, 16) & ~WIN_READ_MASK) === 0;
  }
  if (rights === "" || rights.length % 2 !== 0) return false;
  for (let i = 0; i < rights.length; i += 2) {
    if (!WIN_READ_CODES.has(rights.slice(i, i + 2))) return false;
  }
  return true;
}

/**
 * DACL の SDDL から、ACL の問題の理由（問題がなければ `undefined`）。分からない形は拒む。
 * 拒否（deny）の ACE は、締めるだけなので見ない。許可（allow）の ACE の相手が、自分・`WIN_TRUSTED` でなければ問題にする
 * （`noWrite` のときは、「読む・実行する」だけの許可は通す）。
 */
export function winAclProblemOfSddl(
  sddl: string | undefined,
  selfSid: string | undefined,
  level: AclLevel = "private",
): string | undefined {
  const unknown = "ACL を確かめられない（icacls・whoami が失敗した・時間切れ・出力が想定外）";
  if (sddl === undefined || selfSid === undefined || !/^S-1-[0-9-]+$/.test(selfSid)) return unknown;
  // DACL がない（誰でも何でもできる）
  if (sddl.includes("NO_ACCESS_CONTROL"))
    return "ACL がない（誰でも読み書きできる。icacls で付ける）";
  const m = /^D:([A-Z]*)((?:\([^()]*\))*)$/.exec(sddl);
  if (m === null) return unknown;
  for (const ace of (m[2] ?? "").match(/\([^()]*\)/g) ?? []) {
    const f = ace.slice(1, -1).split(";");
    if (f.length !== 6) return unknown;
    const [type = "", , rights = "", , , who = ""] = f;
    if (type === "D") continue;
    if (type !== "A") return unknown;
    if (who === selfSid || WIN_TRUSTED.has(who)) continue;
    if (level === "noWrite" && winRightsReadOnly(rights)) continue;
    return level === "noWrite"
      ? "ほかの利用者が書き込める ACL が付いている（icacls で外す）"
      : "ほかの利用者に許可する ACL が付いている（icacls で外す）";
  }
  return undefined;
}

/**
 * `stat` の mode から、権限として確かめる値（下位 9 ビット）。
 * Windows の mode は権限を映さない（いつも 0666）ので、ディレクトリは 0700、ほかは 0600 と読み替える（守りは ACL の確かめに任せる）。
 */
export function permMode(mode: number, platform: NodeJS.Platform = process.platform): number {
  if (platform !== "win32") return mode & 0o777;
  return (mode & constants.S_IFMT) === constants.S_IFDIR ? 0o700 : 0o600;
}

/**
 * 自分の uid（`stat` の uid と比べる値）。Windows の `stat` の uid はいつも 0 なので、0 を返す（持ち主は確かめられない。ACL の確かめに任せる）。
 * 取得できない環境では `undefined`。
 */
export function ownUid(platform: NodeJS.Platform = process.platform): number | undefined {
  return platform === "win32" ? 0 : process.getuid?.();
}

interface LsLine {
  readonly ino: string;
  readonly mode: string;
}

/**
 * Windows: `ls -ld` の 1 列目に当たる文字列を、ACL から作る（`modeString` を見る箇所が、そのまま使えるように）。
 * ほかの人に許可がなければ `rwx------`（ファイルは `rw-------`）、読む・実行するだけなら `rwxr-xr-x`（`rw-r--r--`）、
 * 書ける許可があれば末尾に `+`（ACL あり、として拒まれる）。確かめられなければ `undefined`。
 */
function winLsLine(path: string, ops: AclOps): LsLine | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
  const dir = st.isDirectory();
  const type = st.isSymbolicLink() ? "l" : dir ? "d" : "-";
  const win = ops.win ?? defaultWinAcl;
  const sddl = win.sddl(path);
  const self = win.selfSid();
  if (sddl === undefined || self === undefined) return undefined;
  const ino = st.ino.toString();
  if (winAclProblemOfSddl(sddl, self, "private") === undefined) {
    return { ino, mode: `${type}${dir ? "rwx" : "rw-"}------` };
  }
  const open = `${type}${dir ? "rwxr-xr-x" : "rw-r--r--"}`;
  return {
    ino,
    mode: winAclProblemOfSddl(sddl, self, "noWrite") === undefined ? open : `${open}+`,
  };
}

function lsLine(path: string, ops: AclOps): LsLine | undefined {
  const platform = ops.platform ?? process.platform;
  if (platform === "win32") return winLsLine(path, ops);
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
      // 厳しさ（Windows だけで効く）が違う確かめを混ぜない
      key = `${st.dev}:${st.ino}:${st.ctimeNs}:${st.mode}:${st.uid}:${ops.level ?? "private"}`;
    } catch {
      return "ACL を確かめられない（開いたファイルを fstat できない）";
    }
    if (verified.has(key)) return undefined;
  }
  if ((ops.platform ?? process.platform) === "win32") {
    const win = ops.win ?? defaultWinAcl;
    // icacls の前と後で、同じもの（リンクでない）であることを確かめる。リンク・ジャンクションは、
    // リンク自身の ACL しか読めない（指す先の ACL は分からない）ので拒む
    const look = (): bigint | undefined => {
      try {
        const st = lstatSync(path, { bigint: true });
        return st.isSymbolicLink() ? undefined : st.ino;
      } catch {
        return undefined;
      }
    };
    const before = look();
    if (before === undefined) return "ACL を確かめられない（ない・リンク・ジャンクション）";
    const why = winAclProblemOfSddl(win.sddl(path), win.selfSid(), ops.level);
    if (why !== undefined) return why;
    if (look() !== before || (ino !== undefined && before !== ino)) {
      return "ACL を確かめられない（確かめたものと、開いたものが違う）";
    }
    if (key !== undefined) {
      if (verified.size >= CACHE_MAX) verified.clear();
      verified.add(key);
    }
    return undefined;
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

/**
 * ディレクトリを fsync する（rename・作成を永続にする）。Windows では、ディレクトリのハンドルを fsync できない（EPERM）ので、何もしない
 * （NTFS は、名前の変更をジャーナルに書く）。
 */
export function fsyncDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** ACL の確かめ。問題がなければ `undefined`、あれば理由（拒む）。`fd` は開いたもの（あれば、inode を照らす）。 */
export type AclCheck = (path: string, fd?: number, level?: AclLevel) => string | undefined;

/** 既定の確かめ（本物の `/bin/ls`。Windows は `icacls`）。`level` は Windows だけで効く（既定は `private`）。 */
export const defaultAclCheck: AclCheck = (path, fd, level) =>
  aclProblem(path, {
    ...(fd === undefined ? {} : { fd }),
    ...(level === undefined ? {} : { level }),
  });

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
    // Windows には O_NOFOLLOW・O_NONBLOCK がない（undefined は 0 になる）。リンクは、開く前に lstat で拒む
    // （開いたあとに、fd と path の inode を ACL の確かめで照らすので、間に差し替えられても拒む）。
    // ディレクトリは、Windows では開けない（EISDIR・EPERM）ので、ここで「通常のファイルでない」にする。
    if (process.platform === "win32") {
      const l = lstatSync(path);
      if (l.isSymbolicLink()) throw Object.assign(new Error("link"), { code: "ELOOP" });
      if (!l.isFile()) throw new SecureFileError("notFile", "通常のファイルでない");
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (e instanceof SecureFileError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SecureFileError("missing", "ない");
    if (code === "ELOOP") throw new SecureFileError("link", "リンクになっている");
    throw new SecureFileError("io", `開けない（${String(code)}）`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SecureFileError("notFile", "通常のファイルでない");
    const uid = "uid" in opts ? opts.uid : ownUid();
    if (uid !== undefined && st.uid !== uid)
      throw new SecureFileError("owner", "持ち主が自分でない");
    const mode = permMode(st.mode);
    if ((mode & opts.forbid) !== 0) {
      throw new SecureFileError("mode", `権限が緩い（${mode.toString(8)}）`);
    }
    if (st.size > opts.maxBytes) throw new SecureFileError("size", "大きすぎる");
    const why = (opts.acl ?? defaultAclCheck)(path, fd, aclLevelOf(opts.forbid));
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
