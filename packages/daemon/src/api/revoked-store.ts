/**
 * 失効させたトークンのハッシュの永続化（NFR_013）。daemon を起動し直しても、失効済みのトークンを
 * `wasExpired` で expired と返せるようにする（起動し直しで invalid にならない）。
 *
 * - 保存するのはトークンの SHA-256（16 進）と、そのトークンの最長の期限（`expiresAt`。この時刻を過ぎたら、時間だけで
 *   expired になるので、印を残す必要がなくなる）。トークンそのものは保存しない。
 * - 守りは、ノードのトークンの台帳（`token-repository.ts`）と同じ: ファイルは 0600、ディレクトリは 0700、
 *   読みは `readSecureSecret`（所有者・権限・リンクの確かめ）、書きは一時ファイル（0600・O_EXCL）から `rename`。
 * - 読み書きのたびに、期限を過ぎた印は落とす（際限なく増やさない）。上限（`REVOKED_MAX`）を超えたら、期限の早い順に落とす。
 * - 壊れた JSON・不正な形は、警告（`onCorrupt`）を 1 回出して、空で始める。台帳と違い、印は消しても安全側
 *   （失効済みのトークンが expired でなく invalid に戻るだけで、使えるようにはならない）なので、daemon の起動は止めない。
 *   次に書くときに、正しい形で書き直す。権限・所有者・リンクの問題（`readSecureSecret`・ACL）は、いままでどおり失敗させる。
 * - Windows は対象外（POSIX のモード・所有者を前提にする）。
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fsyncDir } from "@touryou/core/fs";
import { assertSecureDirectory, processUid, readSecureSecret } from "./fs-safety.js";

export interface RevokedRecord {
  /** トークンの SHA-256（16 進 64 文字）。 */
  readonly tokenHash: string;
  /** このトークンの最長の期限（ミリ秒。壁時計）。この時刻を過ぎたら、印を落としてよい。 */
  readonly expiresMs: number;
}

export interface RevokedStore {
  /** まだ期限内の失効の印（ハッシュ → 期限のミリ秒）。 */
  load(): Map<string, number>;
  /** 失効の印を足す（すでにあれば、期限は遅い方に寄せる）。失敗したら例外。 */
  add(tokenHash: string, expiresMs: number): void;
}

const FILE_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;
const REVOKED_MAX = 10_000;

function isRevokedRecord(x: unknown): x is RevokedRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.tokenHash === "string" &&
    HASH.test(r.tokenHash) &&
    typeof r.expiresMs === "number" &&
    Number.isFinite(r.expiresMs)
  );
}

export class FileRevokedStore implements RevokedStore {
  private records: Map<string, number> | undefined;
  private readonly getUid: () => number | undefined;

  constructor(
    private readonly path: string,
    options: {
      readonly getUid?: () => number | undefined;
      readonly nowMs?: () => number;
      /** ファイルの中身が壊れていたとき（空で始める）。原因の短い文。パス・中身は渡さない。 */
      readonly onCorrupt?: (cause: string) => void;
    } = {},
  ) {
    this.getUid = options.getUid ?? processUid;
    this.now = options.nowMs ?? Date.now;
    this.onCorrupt = options.onCorrupt;
  }
  private readonly now: () => number;
  private readonly onCorrupt: ((cause: string) => void) | undefined;

  load(): Map<string, number> {
    const dir = dirname(this.path);
    let dirExists = true;
    try {
      lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      dirExists = false;
    }
    if (dirExists) {
      assertSecureDirectory(dir, this.getUid());
      this.cleanTemp(dir);
    }
    try {
      lstatSync(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = new Map();
        return new Map();
      }
      throw e;
    }
    const text = readSecureSecret(this.path, this.getUid());
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const p = parsed as { version?: unknown; revoked?: unknown } | undefined;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      p?.version !== FILE_VERSION ||
      !Array.isArray(p.revoked) ||
      !p.revoked.every(isRevokedRecord)
    ) {
      this.onCorrupt?.("失効の印のファイルの形が不正なので、空で始める");
      this.records = new Map();
      return new Map();
    }
    const now = this.now();
    const map = new Map<string, number>();
    for (const r of p.revoked) {
      if (r.expiresMs <= now) continue; // 期限を過ぎた印は落とす
      map.set(r.tokenHash, Math.max(map.get(r.tokenHash) ?? 0, r.expiresMs));
    }
    this.records = map;
    return new Map(map);
  }

  add(tokenHash: string, expiresMs: number): void {
    if (!HASH.test(tokenHash)) throw new Error("失効の印のハッシュが不正");
    const records = this.records ?? this.load();
    const now = this.now();
    const next = new Map<string, number>();
    // 期限を過ぎた印を落としながら作り直す。
    for (const [h, exp] of records) if (exp > now) next.set(h, exp);
    next.set(tokenHash, Math.max(next.get(tokenHash) ?? 0, expiresMs));
    // 上限を超えたら、期限の早い順に落とす。
    if (next.size > REVOKED_MAX) {
      const sorted = [...next.entries()].sort((a, b) => a[1] - b[1]);
      for (const [h] of sorted.slice(0, next.size - REVOKED_MAX)) next.delete(h);
    }
    this.write(next);
    this.records = next;
  }

  private cleanTemp(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (!/^\.revoked-[0-9]+-[0-9]+\.tmp$/.test(name)) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        // 消せなくても続ける（次の起動でまた試す）。
      }
    }
  }

  private write(records: ReadonlyMap<string, number>): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertSecureDirectory(dir, this.getUid());
    const tmp = join(dir, `.revoked-${process.pid}-${Date.now()}.tmp`);
    const revoked = [...records.entries()].map(([tokenHash, expiresMs]) => ({
      tokenHash,
      expiresMs,
    }));
    const body = `${JSON.stringify({ version: FILE_VERSION, revoked }, null, 2)}\n`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    fsyncDir(dir);
  }
}

/** テスト・永続化しない構成用。 */
export class MemoryRevokedStore implements RevokedStore {
  private readonly records = new Map<string, number>();
  load(): Map<string, number> {
    return new Map(this.records);
  }
  add(tokenHash: string, expiresMs: number): void {
    this.records.set(tokenHash, Math.max(this.records.get(tokenHash) ?? 0, expiresMs));
  }
}
