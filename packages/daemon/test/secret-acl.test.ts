/**
 * daemon が起動時に読む秘密・置き場の ACL。`@touryou/mcp/relay` の共通の確かめを使い、分からないときは拒む。
 * 対象: 認証情報の置き場・ファイル（fs-safety。状態の置き場・root-token・トークンの台帳・人のトークンが使う）・設定ファイル・
 * port・子の引き出しの置き場と鍵のファイル。
 * macOS では、`xattr -w`・`chmod +a` の終了コードを確かめてから、本物のファイルで確かめる。Linux では本物の ACL の試験はスキップする。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSecureDirectory,
  assertSecureFile,
  processUid,
  readSecureSecret,
} from "../src/api/fs-safety.js";
import { CHILDREN_DIR, CHILDREN_KEY_FILE, prepareChildrenDirs } from "../src/children-dir.js";
import { loadConfigFile } from "../src/config.js";
import { readSavedPort } from "../src/port-file.js";

const isMac = process.platform === "darwin";
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "touryou-dacl-"));
  chmodSync(d, 0o700);
  made.push(d);
  return d;
};
const secretFile = (name = "f", text = "x\n") => {
  const p = join(dir(), name);
  writeFileSync(p, text, { mode: 0o600 });
  return p;
};
const must = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} が失敗した（${r.status}）: ${r.stderr}`);
};
const xattr = (p: string) => must("xattr", ["-w", "com.example.touryou-test", "1", p]);
const acl = (p: string, isDir = false) =>
  must("chmod", ["+a", isDir ? "everyone allow list" : "everyone allow read", p]);
const STATES = [
  {
    name: "@ と ACL の両方",
    apply: (p: string, d = false) => {
      xattr(p);
      acl(p, d);
    },
    ok: false,
  },
  { name: "ACL だけ", apply: (p: string, d = false) => acl(p, d), ok: false },
  { name: "拡張属性だけ", apply: (p: string) => xattr(p), ok: true },
] as const;
const CONFIG = JSON.stringify({
  stateDir: "/var/touryou/state",
  repoRoot: "/work/repo",
  worktreeRoot: "/work/worktrees",
  rootCwd: "/work/repo",
  rootScope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
});
const noExclude = async () => undefined;

describe("分からないときは拒む（fs-safety の確かめを差し替える）", () => {
  it("確かめが理由を返せば、置き場・ファイルを拒む", () => {
    const d = dir();
    const p = secretFile();
    const unknown = () => "ACL を確かめられない（差し替え）";
    expect(() => assertSecureDirectory(d, processUid(), unknown)).toThrow("ACL を確かめられない");
    expect(() => assertSecureFile(p, processUid(), unknown)).toThrow("ACL を確かめられない");
    expect(() => assertSecureDirectory(d, processUid(), () => undefined)).not.toThrow();
    expect(() => assertSecureFile(p, processUid(), () => undefined)).not.toThrow();
  });
  it("設定・port・子の引き出しの置き場と鍵・認証情報の読み出し: 確かめが理由を返せば拒む", () => {
    const unknown = () => "ACL を確かめられない（差し替え）";
    const pass = () => undefined;
    const c = secretFile("c.json", CONFIG);
    expect(loadConfigFile(c, { acl: pass }).ok).toBe(true);
    const bad = loadConfigFile(c, { acl: unknown });
    expect(bad.ok === false && bad.error.cause).toContain("ACL を確かめられない");
    const port = secretFile("port", "45678\n");
    expect(readSavedPort(port, { acl: pass })).toBe(45678);
    expect(() => readSavedPort(port, { acl: unknown })).toThrow("ACL を確かめられない");
    const st = dir();
    expect(() => prepareChildrenDirs(st, { exclude: noExclude, acl: pass })).not.toThrow();
    // 置き場（ディレクトリ）だけ・鍵のファイルだけを拒む
    for (const target of [join(st, CHILDREN_DIR), join(st, CHILDREN_KEY_FILE)]) {
      expect(() =>
        prepareChildrenDirs(st, {
          exclude: noExclude,
          acl: (p) => (p === target ? unknown() : undefined),
        }),
      ).toThrow("ACL を確かめられない");
    }
    const tok = secretFile("root-token", "t\n");
    expect(readSecureSecret(tok, processUid(), pass)).toBe("t\n");
    expect(() => readSecureSecret(tok, processUid(), unknown)).toThrow("ACL を確かめられない");
    expect(() => readSecureSecret(join(dir(), "none"), processUid())).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });

  it("本物の ls: ACL のないものは通る", () => {
    expect(() => assertSecureDirectory(dir(), processUid())).not.toThrow();
    expect(() => assertSecureFile(secretFile(), processUid())).not.toThrow();
    expect(loadConfigFile(secretFile("c.json", CONFIG)).ok).toBe(true);
    expect(readSavedPort(secretFile("port", "45678\n"))).toBe(45678);
  });
});

describe.runIf(isMac)("macOS の本物のファイル", () => {
  for (const s of STATES) {
    it(`認証情報の置き場: ${s.name}`, () => {
      const d = dir();
      s.apply(d, true);
      const run = () => assertSecureDirectory(d, processUid());
      if (s.ok) expect(run).not.toThrow();
      else expect(run).toThrow("ACL");
    });
    it(`認証情報のファイル: ${s.name}`, () => {
      const p = secretFile();
      s.apply(p);
      const run = () => assertSecureFile(p, processUid());
      if (s.ok) expect(run).not.toThrow();
      else expect(run).toThrow("ACL");
      const read = () => readSecureSecret(p, processUid());
      if (s.ok) expect(read()).toBe("x\n");
      else expect(read).toThrow("ACL");
    });
    it(`設定ファイル: ${s.name}`, () => {
      const p = secretFile("c.json", CONFIG);
      s.apply(p);
      expect(loadConfigFile(p).ok).toBe(s.ok);
    });
    it(`port: ${s.name}`, () => {
      const p = secretFile("port", "45678\n");
      s.apply(p);
      if (s.ok) expect(readSavedPort(p)).toBe(45678);
      else expect(() => readSavedPort(p)).toThrow();
    });
    it(`子の引き出しの置き場: ${s.name}`, () => {
      const st = dir();
      mkdirSync(join(st, CHILDREN_DIR), { mode: 0o700 });
      s.apply(join(st, CHILDREN_DIR), true);
      const run = () => prepareChildrenDirs(st, { exclude: noExclude });
      if (s.ok) expect(run).not.toThrow();
      else expect(run).toThrow("ACL");
    });
    it(`子の引き出しの鍵のファイル: ${s.name}`, () => {
      const st = dir();
      prepareChildrenDirs(st, { exclude: noExclude });
      s.apply(join(st, CHILDREN_KEY_FILE));
      const run = () => prepareChildrenDirs(st, { exclude: noExclude });
      if (s.ok) expect(run).not.toThrow();
      else expect(run).toThrow("ACL");
    });
  }
});
