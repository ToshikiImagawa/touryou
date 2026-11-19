import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Scope } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { resolveScope, withRealWritePath } from "../../src/sdk/hook-policy.js";
import { type FsOps, resolveForWrite, winAbsolute } from "../../src/sdk/path-resolve.js";

// Windows の形（style = win）の実パス化を、作りもののファイルシステムで確かめる（どの OS でも動く）。
// `links` は「リンク → 先」、`dirs` はあるディレクトリ、`dangling` は先の無いリンク。大文字小文字は区別しない。
function fakeFs(
  dirs: readonly string[],
  links: Readonly<Record<string, string>> = {},
  dangling: readonly string[] = [],
): FsOps & { readonly seen: string[] } {
  const key = (p: string): string => p.toLowerCase().replace(/[\\/]+$/, "");
  const enoent = (): Error => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const seen: string[] = [];
  const real = (p: string): string | undefined => {
    for (const [from, to] of Object.entries(links)) {
      if (key(p) === key(from)) return to;
      if (key(p).startsWith(`${key(from)}\\`)) return real(`${to}${p.slice(key(from).length)}`);
    }
    return dirs.some((d) => key(d) === key(p)) ? p : undefined;
  };
  return {
    seen,
    realpath: async (p) => {
      seen.push(p);
      const r = real(p);
      if (r === undefined) throw enoent();
      return r;
    },
    lstat: async (p) => {
      if (!dangling.some((d) => key(d) === key(p))) throw enoent();
      return {};
    },
  };
}

const DIRS = [
  "C:\\",
  "C:\\work",
  "C:\\work\\src",
  "C:\\outside",
  "\\\\srv\\share",
  "\\\\srv\\share\\w",
];

describe("resolveForWrite（style = win）", () => {
  it("最も深い既存の祖先を実パスにして、残りを `\\` でつなぐ。区切りは `/` でもよい", async () => {
    const fs = fakeFs(DIRS);
    expect(await resolveForWrite("C:\\work\\src", fs, "win")).toBe("C:\\work\\src");
    expect(await resolveForWrite("C:\\work\\src\\new\\a.ts", fs, "win")).toBe(
      "C:\\work\\src\\new\\a.ts",
    );
    expect(await resolveForWrite("C:/work/src/new/a.ts", fs, "win")).toBe(
      "C:\\work\\src\\new\\a.ts",
    );
    expect(await resolveForWrite("C:\\none\\a", fs, "win")).toBe("C:\\none\\a");
    expect(await resolveForWrite("\\\\srv\\share\\w\\a\\b", fs, "win")).toBe(
      "\\\\srv\\share\\w\\a\\b",
    );
  });
  it("リンク（ジャンクション）の先が外なら、外の実パスになる。先の無いリンクは拒否する", async () => {
    const fs = fakeFs(DIRS, { "C:\\work\\src\\link": "C:\\outside" }, ["C:\\work\\src\\dangling"]);
    expect(await resolveForWrite("C:\\work\\src\\link\\new.txt", fs, "win")).toBe(
      "C:\\outside\\new.txt",
    );
    await expect(resolveForWrite("C:\\work\\src\\dangling", fs, "win")).rejects.toThrow();
    await expect(resolveForWrite("C:\\work\\src\\dangling\\x", fs, "win")).rejects.toThrow();
  });
  it("`..` は字面で畳み、根より上には行かない（別のドライブ・別の共有に化けない）", async () => {
    const fs = fakeFs(DIRS);
    expect(await resolveForWrite("C:\\work\\..\\..\\..\\x", fs, "win")).toBe("C:\\x");
    expect(await resolveForWrite("\\\\srv\\share\\w\\..\\..\\..\\x", fs, "win")).toBe(
      "\\\\srv\\share\\x",
    );
    // 根より上を尋ねない（`C:\` の上・共有の上の実パスを取りに行かない）
    expect(fs.seen.every((p) => /^C:\\/.test(p) || p.startsWith("\\\\srv\\share"))).toBe(true);
  });
  it("絶対パスでない・根が決まらない・NUL を含むものは拒否する", async () => {
    const fs = fakeFs(DIRS);
    for (const p of ["work\\a", "C:work", "\\work\\a", "/work/a", "\\\\srv", "C:\\a\0b", ""]) {
      await expect(resolveForWrite(p, fs, "win"), p).rejects.toThrow();
    }
  });
  it("style を渡さなければ POSIX の形。Windows の形のパスは拒否する（許可の側に倒れない）", async () => {
    await expect(resolveForWrite("C:\\work\\src", fakeFs(DIRS))).rejects.toThrow("絶対パスでない");
  });
});

describe("winAbsolute（絶対パスにする。検査をしないのは、信頼する側のパスだけ）", () => {
  it("子が渡したパス: 相対は基準につなぎ、絶対はそのまま。判定できない形は `undefined`", () => {
    expect(winAbsolute("src\\a.ts", "C:\\work", false)).toBe("C:\\work\\src\\a.ts");
    expect(winAbsolute("src/a.ts", "C:\\work\\", false)).toBe("C:\\work\\src\\a.ts");
    expect(winAbsolute("..\\..\\..\\x", "C:\\work", false)).toBe("C:\\x");
    expect(winAbsolute("D:\\x", "C:\\work", false)).toBe("D:\\x");
    for (const p of [
      "C:foo",
      "\\foo",
      "/foo",
      "\\\\?\\C:\\work\\a",
      "\\\\.\\C:\\work\\a",
      "src\\a.ts:stream",
      "src\\secret.",
      "src\\SECRET~1\\a",
      "src\\NUL",
      "src\\con.txt",
      "\\\\srv",
      "",
      "a\0b",
      "a\u200bb",
    ]) {
      expect(winAbsolute(p, "C:\\work", false), p).toBeUndefined();
    }
  });
  it("基準（作業ツリー）は信頼する側のパス: 8.3 形式の短い名前が入っていても、つなげる", () => {
    expect(winAbsolute("src\\a.ts", "C:\\Users\\RUNNER~1\\work", false)).toBe(
      "C:\\Users\\RUNNER~1\\work\\src\\a.ts",
    );
    // 基準が絶対パスでない・根が決まらないなら、つながない
    expect(winAbsolute("a", "work", false)).toBeUndefined();
    expect(winAbsolute("a", "/work", false)).toBeUndefined();
  });
  it("信頼する側のパス（範囲の場所）: 検査をせずに分ける", () => {
    expect(winAbsolute("src", "C:\\work", true)).toBe("C:\\work\\src");
    expect(winAbsolute("C:\\Users\\RUNNER~1\\x", "C:\\work", true)).toBe("C:\\Users\\RUNNER~1\\x");
    expect(winAbsolute("\\\\?\\C:\\work\\src", "C:\\work", true)).toBe("C:\\work\\src");
  });
});

describe("withRealWritePath・resolveScope（style = win）", () => {
  const fs = fakeFs(
    [...DIRS, "C:\\Users\\RUNNER~1\\wt", "C:\\Users\\RUNNER~1\\wt\\src"],
    { "C:\\work\\viasrc": "C:\\work\\src" },
    ["C:\\work\\dangling"],
  );
  const resolve = (p: string) => resolveForWrite(p, fs, "win");

  it("withRealWritePath: 子が渡したパスは検査する。判定できない形は、入力をそのまま返す", async () => {
    expect(
      await withRealWritePath("Write", { file_path: "viasrc\\a.ts" }, "C:\\work", resolve, "win"),
    ).toEqual({ file_path: "C:\\work\\src\\a.ts" });
    expect(
      await withRealWritePath("Edit", { file_path: "C:/work/src/a.ts" }, "C:\\x", resolve, "win"),
    ).toEqual({ file_path: "C:\\work\\src\\a.ts" });
    // 作業ツリーの側に短い名前が入っていても、動く
    expect(
      await withRealWritePath(
        "Write",
        { file_path: "src\\a.ts" },
        "C:\\Users\\RUNNER~1\\wt",
        resolve,
        "win",
      ),
    ).toEqual({ file_path: "C:\\Users\\RUNNER~1\\wt\\src\\a.ts" });
    for (const p of ["C:src\\a.ts", "\\work\\src\\a.ts", "src\\NUL", "src\\a.ts.", "src\\A~1.TS"]) {
      const input = { file_path: p };
      expect(await withRealWritePath("Write", input, "C:\\work", resolve, "win"), p).toBe(input);
    }
    const bash = { command: "ls" };
    expect(await withRealWritePath("Bash", bash, "C:\\work", resolve, "win")).toBe(bash);
  });
  it("style を渡さなければ、いままでどおり POSIX の形として扱う", async () => {
    const posix = async (p: string): Promise<string> => `/real${p}`;
    expect(await withRealWritePath("Write", { file_path: "a" }, "/w/", posix)).toEqual({
      file_path: "/real/w/a",
    });
  });
  it("resolveScope: 場所を実パスにする。解決できない writable は落とし、forbidden は絶対パスで残す", async () => {
    const scope: Scope = {
      writableLocations: ["viasrc", "dangling", "src"],
      forbiddenLocations: ["dangling", "src\\secret", "C:\\outside"],
      allowedCommands: ["ls"],
    };
    const r = await resolveScope(scope, "C:\\work", resolve, "win");
    expect(r.writableLocations).toEqual(["C:\\work\\src", "C:\\work\\src"]);
    expect(r.forbiddenLocations).toEqual([
      "C:\\work\\dangling",
      "C:\\work\\src\\secret",
      "C:\\outside",
    ]);
    expect(r.allowedCommands).toEqual(["ls"]);
  });
});

describe("検査をしない口（lenient）の使い所", () => {
  it("daemon の src で `lenient` を書いているのは、path-resolve.ts の parseTrusted の 1 か所だけ", () => {
    const src = join(import.meta.dirname, "..", "..", "src");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts")) {
          readFileSync(full, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (line.includes("lenient")) hits.push(`${e.name}:${i + 1}: ${line.trim()}`);
            });
        }
      }
    };
    walk(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(
      /^path-resolve\.ts:\d+: const p = parsePath\(raw, style, \{ lenient: true \}\);$/,
    );
    // parseTrusted を呼ぶ所は、信頼する側のパスだけ: 範囲の場所（trusted が真）・基準（作業ツリー）・絶対パスにした後の実パス化
    const text = readFileSync(join(src, "sdk", "path-resolve.ts"), "utf8");
    const calls = text.split("\n").filter((l) => /parseTrusted\(/.test(l) && !/^function /.test(l));
    expect(calls.map((l) => l.trim())).toEqual([
      'const p = trusted ? parseTrusted(raw, "win") : parsePath(raw, "win");',
      'const b = parseTrusted(base, "win");',
      'const p = parseTrusted(absPath, "win");',
    ]);
  });
});
