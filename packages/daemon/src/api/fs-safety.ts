/**
 * 認証情報を置く場所の検査（フェイルクローズ）。Windows は対象外（POSIX のモードと所有者を前提にする）。
 *
 * - ディレクトリ: シンボリックリンクでない実のディレクトリで、所有者がこのプロセスと同じで、グループ・他者から書き込めない。
 *   （書き込めると、ファイルの差し替え・一時ファイルの細工ができる）
 * - ファイル: シンボリックリンクでない通常のファイルで、所有者がこのプロセスと同じで、グループ・他者に権限がない（0600）。
 * - どちらも ACL が付いていないこと（mode ビットは ACL を映さない。`@touryou/mcp/relay` の `aclProblem`。分からないときは拒む）。
 */

import { lstatSync } from "node:fs";
import {
  type AclCheck,
  defaultAclCheck,
  ownUid,
  permMode,
  readSecureFile,
  SecureFileError,
} from "@touryou/core/fs";

export type { AclCheck };

/** このプロセスのユーザー ID。取得できない環境では `undefined`（所有者は確かめない）。 */
export const processUid = (): number | undefined => ownUid();

const octal = (mode: number): string => permMode(mode).toString(8);

export function assertSecureDirectory(
  dir: string,
  uid: number | undefined,
  acl: AclCheck = defaultAclCheck,
): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) {
    throw new Error(`認証情報のディレクトリ ${dir} が実のディレクトリでない（リンクなどは不可）`);
  }
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`認証情報のディレクトリ ${dir} の所有者が、このプロセスのユーザーと違う`);
  }
  if ((permMode(st.mode) & 0o022) !== 0) {
    throw new Error(
      `認証情報のディレクトリ ${dir} が、グループ・他者から書き込める（0700 にする）: ${octal(st.mode)}`,
    );
  }
  // Windows では、ほかの利用者の「読む・実行する」だけの許可は通す（POSIX の 0o022 に当たる）
  const why = acl(dir, undefined, "noWrite");
  if (why !== undefined) throw new Error(`認証情報のディレクトリ ${dir} に、${why}`);
}

export function assertSecureFile(
  path: string,
  uid: number | undefined,
  acl: AclCheck = defaultAclCheck,
): void {
  const st = lstatSync(path);
  if (!st.isFile())
    throw new Error(`認証情報のファイル ${path} が通常のファイルでない（リンクなどは不可）`);
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`認証情報のファイル ${path} の所有者が、このプロセスのユーザーと違う`);
  }
  if ((permMode(st.mode) & 0o077) !== 0) {
    throw new Error(`認証情報のファイル ${path} の権限が緩い（0600 にする）: ${octal(st.mode)}`);
  }
  const why = acl(path);
  if (why !== undefined) throw new Error(`認証情報のファイル ${path} に、${why}`);
}

/** 認証情報のファイルの大きさの上限（4 MiB。トークンの台帳を含む）。 */
const SECRET_MAX_BYTES = 4 * 1024 * 1024;

/**
 * 認証情報のファイルを読む。リンクを開かずに開き、開いた fd で `assertSecureFile` と同じ確かめ（通常のファイル・持ち主・0600・ACL。
 * ACL は fd と inode を照らす）をしてから、fd から読む（確かめたものと読むものを同じにする）。ないときは `code: "ENOENT"` の例外。
 */
export function readSecureSecret(
  path: string,
  uid: number | undefined,
  acl: AclCheck = defaultAclCheck,
): string {
  try {
    return readSecureFile(path, { forbid: 0o077, maxBytes: SECRET_MAX_BYTES, uid, acl });
  } catch (e) {
    if (!(e instanceof SecureFileError)) throw e;
    switch (e.code) {
      case "missing":
        throw Object.assign(new Error(`認証情報のファイル ${path} がない`), { code: "ENOENT" });
      case "link":
      case "notFile":
        throw new Error(`認証情報のファイル ${path} が通常のファイルでない（リンクなどは不可）`);
      case "owner":
        throw new Error(`認証情報のファイル ${path} の所有者が、このプロセスのユーザーと違う`);
      case "mode":
        throw new Error(`認証情報のファイル ${path} の権限が緩い（0600 にする）: ${e.message}`);
      case "acl":
        throw new Error(`認証情報のファイル ${path} に、${e.message}`);
      default:
        throw new Error(`認証情報のファイル ${path} を読めない（${e.message}）`);
    }
  }
}
