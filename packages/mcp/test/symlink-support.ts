/**
 * シンボリックリンクを作れるか（試験の前に 1 回だけ確かめる）。
 *
 * Windows では、開発者モードか管理者の権限がないと、リンクを作れない（EPERM）。作れない環境では、リンクを作って確かめる試験を
 * `it.skipIf(!CAN_SYMLINK)` で飛ばす（理由は SYMLINK_SKIP_REASON）。macOS・Linux では、いつも true。
 */
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const probe = (): boolean => {
  if (process.platform !== "win32") return true;
  const d = mkdtempSync(join(tmpdir(), "touryou-symlink-probe-"));
  try {
    symlinkSync(d, join(d, "l"), "dir");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
    throw e;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

export const CAN_SYMLINK = probe();
export const SYMLINK_SKIP_REASON =
  "Windows で、シンボリックリンクを作れない（開発者モードか管理者の権限が要る）";
if (!CAN_SYMLINK) console.warn(`[skip] ${SYMLINK_SKIP_REASON}。リンクを作る試験を飛ばす`);
