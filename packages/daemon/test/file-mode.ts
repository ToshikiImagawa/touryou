/**
 * 試験で、ファイル・ディレクトリの権限（0600・0700 など）を確かめるための値。
 *
 * macOS・Linux では `lstat` の `mode & 0o777`。Windows の `mode` は ACL を映さない（いつも 0666・0777 など）ので、ACL から作った
 * `ls -ld` の形（core の `modeString`）を、権限のビットに直す（ほかの人に許可がなければ 0600・0700）。確かめられなければ -1。
 */
import { lstatSync } from "node:fs";
import { modeString } from "@touryou/core/fs";

const BITS = "rwxrwxrwx";

export const fileMode = (path: string): number => {
  if (process.platform !== "win32") return lstatSync(path).mode & 0o777;
  const m = modeString(path);
  if (m === undefined || m.endsWith("+")) return -1;
  let bits = 0;
  for (let i = 0; i < 9; i++) if (m[i + 1] === BITS[i]) bits |= 1 << (8 - i);
  return bits;
};

/**
 * chmod で権限を緩められるか。Windows の chmod は読み取り専用の旗しか変えず、ACL を緩められないので、「緩い権限のファイルを
 * 拒む」試験は確かめようがない（`it.skipIf(!CHMOD_LOOSENS)` で飛ばす）。Windows の ACL による拒否は、core の fs.test.ts の
 * win32 の試験（SDDL の判定）と、ACL を差し替える試験で確かめる。
 */
export const CHMOD_LOOSENS = process.platform !== "win32";
if (!CHMOD_LOOSENS)
  console.warn("[skip] Windows の chmod では ACL を緩められない。緩い権限を拒む試験を飛ばす");
