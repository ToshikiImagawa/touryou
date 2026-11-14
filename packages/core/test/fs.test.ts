import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aclProblem,
  classifyMode,
  clearAclCache,
  createLsRunner,
  type LsResult,
  type LsRunner,
  modeString,
  readSecureFile,
  SecureFileError,
} from "../src/fs.js";

const isMac = process.platform === "darwin";
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  clearAclCache();
});
const must = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} が失敗した（${r.status}）: ${r.stderr}`);
};
const file = (text = "x") => {
  const d = mkdtempSync(join(tmpdir(), "touryou-acl-"));
  made.push(d);
  const p = join(d, "f");
  writeFileSync(p, text, { mode: 0o600 });
  return { d, p };
};
const WHY = "ACL を確かめられない";

describe("classifyMode", () => {
  it("印なし・@・.（SELinux）は plain。+ は acl", () => {
    expect(classifyMode("-rw-------")).toBe("plain");
    expect(classifyMode("-rw-------@")).toBe("plain");
    expect(classifyMode("-rw-------.")).toBe("plain");
    expect(classifyMode("drwx------")).toBe("plain");
    expect(classifyMode("-rw-------+")).toBe("acl");
    expect(classifyMode("-rw-------@+")).toBe("acl");
  });
  it("読めない・形が想定外は unknown（拒む）", () => {
    expect(classifyMode(undefined)).toBe("unknown");
    expect(classifyMode("")).toBe("unknown");
    expect(classifyMode("total")).toBe("unknown");
    expect(classifyMode("-rw-------x")).toBe("unknown");
    expect(classifyMode("-rw----")).toBe("unknown");
  });
});

describe("modeString・aclProblem（ls を差し替える）", () => {
  const fake =
    (r: Partial<LsResult> & { stdout: string }, seen?: string[][]): LsRunner =>
    (args) => {
      seen?.push([...args]);
      return { status: 0, ...r };
    };

  it("macOS は ls -ldei -- を使い、ACL の行があれば @ のあとに + を足す", () => {
    const seen: string[][] = [];
    const run = fake(
      { stdout: "  1234 -rw-------@ 1 u staff 1 Jan 1 00:00 /p\n 0: group:everyone allow read\n" },
      seen,
    );
    expect(modeString("/p", { run, platform: "darwin" })).toBe("-rw-------@+");
    expect(seen[0]).toEqual(["-ldei", "--", "/p"]);
    expect(aclProblem("/p", { run, platform: "darwin" })).toContain("ACL が付いている");
  });

  it("macOS で拡張属性だけ（ACL の行なし）なら、問題なし", () => {
    const run = fake({ stdout: "1234 -rw-------@ 1 u staff 1 Jan 1 00:00 /p\n" });
    expect(aclProblem("/p", { run, platform: "darwin" })).toBeUndefined();
  });

  it("Linux は ls -ldi -- の + を見る", () => {
    const seen: string[][] = [];
    const run = fake({ stdout: "1234 -rw-------+ 1 u u 1 x /p\n" }, seen);
    expect(aclProblem("/p", { run, platform: "linux" })).toContain("ACL が付いている");
    expect(seen[0]).toEqual(["-ldi", "--", "/p"]);
  });

  it("分からないときは拒む: 失敗・時間切れ（error・signal）・投げた・出力が空・inode がない・形が想定外", () => {
    const line = "1234 -rw------- 1 u u 1 x /p\n";
    for (const platform of ["darwin", "linux"] as const) {
      const cases: LsRunner[] = [
        fake({ status: 1, stdout: "" }),
        fake({ status: null, stdout: "" }),
        fake({ status: null, signal: "SIGKILL", stdout: line }),
        fake({ status: 0, signal: "SIGKILL", stdout: line }),
        fake({ status: 0, error: new Error("ETIMEDOUT"), stdout: line }),
        () => {
          throw new Error("spawn failed");
        },
        fake({ stdout: "" }),
        fake({ stdout: "-rw------- 1 u u 1 x /p\n" }), // inode の列がない
        fake({ stdout: "ls: something odd\n" }),
        fake({ stdout: "1234 -rw-------? 1 u u 1 x /p\n" }),
      ];
      for (const [i, run] of cases.entries()) {
        expect(aclProblem("/p", { run, platform }), `${platform} ${i}`).toContain(WHY);
      }
    }
  });

  it("win32 は対象外で、全部拒む（ls を呼ばない）", () => {
    let called = false;
    const run: LsRunner = () => {
      called = true;
      return { status: 0, stdout: "1 -rw------- 1 u u 1 x /p\n" };
    };
    expect(aclProblem("/p", { run, platform: "win32" })).toContain(WHY);
    expect(called).toBe(false);
  });

  it("fd を渡すと inode を照らす。違えば拒む（パスが差し替えられた）", () => {
    const { p } = file();
    const fd = openSync(p, "r");
    try {
      const ino = statSync(p).ino;
      const run = (n: number | bigint) => fake({ stdout: `${n} -rw------- 1 u u 1 x ${p}\n` });
      expect(aclProblem(p, { fd, run: run(ino + 1), platform: "linux" })).toContain(
        "開いたものが違う",
      );
      expect(
        aclProblem(p, { fd, run: run(statSync(p, { bigint: true }).ino), platform: "linux" }),
      ).toBeUndefined();
    } finally {
      closeSync(fd);
    }
  });

  it("照らしが通ったものは覚えて ls を起こさない。ctime が変われば（chmod など）確かめ直す", () => {
    const { p } = file();
    let calls = 0;
    const run: LsRunner = () => {
      calls += 1;
      return {
        status: 0,
        stdout: `${statSync(p, { bigint: true }).ino} -rw------- 1 u u 1 x ${p}\n`,
      };
    };
    const check = () => {
      const fd = openSync(p, "r");
      try {
        return aclProblem(p, { fd, run, platform: "linux" });
      } finally {
        closeSync(fd);
      }
    };
    expect(check()).toBeUndefined();
    expect(check()).toBeUndefined();
    expect(calls).toBe(1);
    const before = statSync(p, { bigint: true }).ctimeNs;
    for (let i = 0; i < 50 && statSync(p, { bigint: true }).ctimeNs === before; i++) {
      chmodSync(p, 0o600);
    }
    expect(statSync(p, { bigint: true }).ctimeNs).not.toBe(before);
    expect(check()).toBeUndefined();
    expect(calls).toBe(2);
    // 拒んだものは覚えない
    const bad: LsRunner = () => ({ status: 1, stdout: "" });
    const fd = openSync(p, "r");
    try {
      clearAclCache();
      expect(aclProblem(p, { fd, run: bad, platform: "linux" })).toContain(WHY);
      expect(aclProblem(p, { fd, run: bad, platform: "linux" })).toContain(WHY);
    } finally {
      closeSync(fd);
    }
  });

  it("本物の時間切れ: 止まる ls は打ち切って拒む", () => {
    const { d } = file();
    const slow = join(d, "slow-ls");
    writeFileSync(slow, "#!/bin/sh\nexec sleep 10\n", { mode: 0o700 });
    const started = Date.now();
    const why = aclProblem("/p", { run: createLsRunner({ command: slow, timeoutMs: 200 }) });
    expect(why).toContain(WHY);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("本物の /bin/ls: ACL のない 0600 のファイル・ディレクトリは問題なし。ないファイル・- で始まる名前も正しく扱う", () => {
    const { d, p } = file();
    expect(aclProblem(p)).toBeUndefined();
    expect(aclProblem(d)).toBeUndefined();
    expect(aclProblem(join(d, "missing"))).toContain(WHY);
    const dash = join(d, "-l");
    writeFileSync(dash, "x", { mode: 0o600 });
    const fd = openSync(dash, "r");
    try {
      expect(aclProblem(dash, { fd })).toBeUndefined();
    } finally {
      closeSync(fd);
    }
  });
});

describe("readSecureFile", () => {
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof SecureFileError ? e.code : "other";
    }
    return "none";
  };
  it("0600 の自分のファイルを読む。ない・リンク・緩い・大きい・ACL の確かめが拒むなら読まない", () => {
    const { d, p } = file("secret\n");
    const opts = { forbid: 0o077, maxBytes: 64 };
    expect(readSecureFile(p, opts)).toBe("secret\n");
    expect(code(() => readSecureFile(join(d, "none"), opts))).toBe("missing");
    const link = join(d, "link");
    symlinkSync(p, link);
    expect(code(() => readSecureFile(link, opts))).toBe("link");
    expect(code(() => readSecureFile(d, opts))).toBe("notFile");
    expect(code(() => readSecureFile(p, { ...opts, uid: 99999 }))).toBe("owner");
    expect(code(() => readSecureFile(p, { ...opts, maxBytes: 2 }))).toBe("size");
    expect(
      code(() => readSecureFile(p, { ...opts, acl: () => "ACL を確かめられない（差し替え）" })),
    ).toBe("acl");
    chmodSync(p, 0o640);
    expect(code(() => readSecureFile(p, opts))).toBe("mode");
    expect(readSecureFile(p, { ...opts, forbid: 0o022 })).toBe("secret\n");
  });
  it("ACL の確かめには、開いた fd を渡す（開いたあとにパスを差し替えても、照らしで拒む）", () => {
    const { d, p } = file("a\n");
    const other = join(d, "other");
    writeFileSync(other, "b\n", { mode: 0o600 });
    const seen: (number | undefined)[] = [];
    expect(
      code(() =>
        readSecureFile(p, {
          forbid: 0o077,
          maxBytes: 64,
          acl: (path, fd) => {
            seen.push(fd);
            renameSync(other, path); // 開いたあとで、パスを別のファイルに差し替える
            return aclProblem(path, fd === undefined ? {} : { fd });
          },
        }),
      ),
    ).toBe("acl");
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]).toBe("number");
  });
});

describe.runIf(isMac)("macOS の本物のファイル（xattr・chmod +a の終了コードを確かめる）", () => {
  it("@ と ACL の両方: 拒む", () => {
    const { p } = file();
    must("xattr", ["-w", "com.example.touryou-test", "1", p]);
    must("chmod", ["+a", "everyone allow read", p]);
    const ls = spawnSync("ls", ["-lde", p], { encoding: "utf8" });
    expect(ls.stdout.split(" ")[0]).toMatch(/@$/); // `@` が出て `+` が隠れる状態を作れている
    expect(aclProblem(p)).toContain("ACL が付いている");
  });
  it("ACL だけ: 拒む", () => {
    const { p } = file();
    must("chmod", ["+a", "everyone allow read", p]);
    expect(aclProblem(p)).toContain("ACL が付いている");
  });
  it("拡張属性だけ: 問題なし（fd つきでも）", () => {
    const { p } = file();
    must("xattr", ["-w", "com.example.touryou-test", "1", p]);
    expect(aclProblem(p)).toBeUndefined();
    expect(readSecureFile(p, { forbid: 0o077, maxBytes: 64 })).toBe("x");
  });
  it("ディレクトリの @ と ACL の両方: 拒む", () => {
    const { d } = file();
    must("xattr", ["-w", "com.example.touryou-test", "1", d]);
    must("chmod", ["+a", "everyone allow list", d]);
    expect(aclProblem(d)).toContain("ACL が付いている");
  });
});

describe("core の本体は fs を読み込まない", () => {
  it("index から辿れるファイルは、node: と ./fs.js を import しない", async () => {
    const { readFileSync } = await import("node:fs");
    const src = new URL("../src/", import.meta.url);
    const seen = new Set<string>();
    const walk = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const text = readFileSync(new URL(name.replace(/\.js$/, ".ts"), src), "utf8");
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] ?? "";
        expect(spec, name).not.toMatch(/^node:/);
        expect(spec, name).not.toBe("./fs.js");
        if (spec.startsWith("./")) walk(spec.slice(2));
      }
    };
    walk("index.js");
    expect(seen.size).toBeGreaterThan(5);
  });
});
