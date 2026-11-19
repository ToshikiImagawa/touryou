import { describe, expect, it } from "vitest";
import {
  type AbsPath,
  isReservedWinName,
  isUnderForm,
  isUnderPath,
  joinPath,
  type PathStyle,
  parsePath,
  resolvePosixForm,
  toCanonical,
  toNative,
  toPosixForm,
  winPathProblem,
} from "../src/path.js";

const abs = (raw: string, style: PathStyle, lenient = false): AbsPath => {
  const p = parsePath(raw, style, { lenient });
  if (p.kind !== "abs") throw new Error(`絶対パスでない: ${raw} → ${JSON.stringify(p)}`);
  return p;
};
const reason = (raw: string, style: PathStyle): string | undefined => {
  const p = parsePath(raw, style);
  return p.kind === "invalid" ? p.reason : undefined;
};

describe("parsePath（style = posix）", () => {
  it("絶対パスは根（空）と要素に分け、`.`・`..`・重なった区切りを畳む。根より上には行かない", () => {
    expect(abs("/a/b", "posix")).toEqual({
      kind: "abs",
      style: "posix",
      root: "",
      segments: ["a", "b"],
    });
    expect(abs("/a//b/./c/../d/", "posix").segments).toEqual(["a", "b", "d"]);
    expect(abs("/../../a", "posix").segments).toEqual(["a"]);
    expect(abs("/", "posix").segments).toEqual([]);
  });
  it("相対パスは `..` を残す。`\\`・`:`・予約名・末尾の `.` は、ただの文字として扱う", () => {
    expect(parsePath("a/./b/../c", "posix")).toEqual({
      kind: "rel",
      style: "posix",
      segments: ["a", "b", "..", "c"],
    });
    expect(parsePath("a\\b", "posix")).toEqual({ kind: "rel", style: "posix", segments: ["a\\b"] });
    for (const raw of ["/work/NUL", "/work/a.", "/work/C:foo", "/work/SECRET~1", "/work/a:b"]) {
      expect(parsePath(raw, "posix").kind, raw).toBe("abs");
    }
    // POSIX の形では、`C:` で始まる要素も根にならない（`..` で消える）
    expect(abs("/C:/..", "posix").segments).toEqual([]);
  });
  it("空・NUL・書式制御文字は不正。lenient なら分ける", () => {
    expect(reason("", "posix")).toBe("empty");
    expect(reason("  ", "posix")).toBe("empty");
    expect(reason("/a\0b", "posix")).toBe("nul");
    expect(reason("/a\u200bb", "posix")).toBe("formatChar");
    expect(parsePath("", "posix", { lenient: true })).toEqual({
      kind: "rel",
      style: "posix",
      segments: [],
    });
  });
});

describe("parsePath（style = win）", () => {
  it("ドライブの絶対パス: 区切りは `\\` でも `/` でもよい。根（`C:`）より上には行かない", () => {
    expect(abs("C:\\a\\b", "win")).toEqual({
      kind: "abs",
      style: "win",
      root: "C:",
      segments: ["a", "b"],
    });
    expect(abs("c:/a/./b/../c", "win")).toEqual({
      kind: "abs",
      style: "win",
      root: "c:",
      segments: ["a", "c"],
    });
    expect(abs("C:\\..\\..\\a", "win").segments).toEqual(["a"]);
    expect(abs("C:\\", "win").segments).toEqual([]);
  });
  it("UNC: 根は `UNC/srv/share`。`//srv/share` も UNC。共有の名前がなければ不正", () => {
    const p = abs("\\\\srv\\share\\a\\..\\..\\..\\b", "win");
    expect(p.root).toBe("UNC/srv/share");
    expect(p.segments).toEqual(["b"]);
    expect(abs("//srv/share/a", "win").root).toBe("UNC/srv/share");
    expect(reason("\\\\srv", "win")).toBe("incompleteUnc");
    expect(reason("\\\\srv\\", "win")).toBe("incompleteUnc");
  });
  it("相対パス: `\\` も区切り。`..` は残す", () => {
    expect(parsePath("a\\b/..\\c", "win")).toEqual({
      kind: "rel",
      style: "win",
      segments: ["a", "b", "..", "c"],
    });
  });
  it("判定できない形は不正: ドライブ相対・区切り 1 つで始まる・デバイス・ストリーム・別名・予約デバイス名", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["C:foo", "driveRelative"],
      ["C:", "driveRelative"],
      ["\\foo", "rootRelative"],
      ["/foo", "rootRelative"],
      ["\\\\?\\C:\\a", "device"],
      ["\\\\?\\UNC\\srv\\share\\a", "device"],
      ["\\\\.\\PhysicalDrive0", "device"],
      ["//./C:/a", "device"],
      ["C:\\a\\b.txt:stream", "stream"],
      ["a:b", "driveRelative"],
      ["dir\\file:stream", "stream"],
      ["C:\\a\\secret.", "alias"],
      ["C:\\a\\secret \\b", "alias"],
      ["a\\SECRET~1\\b", "alias"],
      ["C:\\a\\NUL", "reservedName"],
      ["nul", "reservedName"],
      ["a\\con.txt", "reservedName"],
      ["C:\\a\\COM1.tar.gz\\b", "reservedName"],
      ["a/LPT9", "reservedName"],
      ["a/aux", "reservedName"],
      ["a/PRN.log", "reservedName"],
      ["a/COM²", "reservedName"],
      ["a/CONIN$", "reservedName"],
      ["", "empty"],
      ["C:\\a\0", "nul"],
      ["C:\\a\u202eb", "formatChar"],
    ];
    for (const [raw, want] of cases) expect(reason(raw, "win"), raw).toBe(want);
  });
  it("予約デバイス名に似ているだけの名前は通す", () => {
    for (const raw of [
      "a\\null",
      "a\\console.log",
      "a\\com10",
      "a\\COM",
      "a\\lpt",
      "a\\x.nul",
      "a\\nul_",
    ]) {
      expect(parsePath(raw, "win").kind, raw).toBe("rel");
    }
    expect(isReservedWinName("NUL")).toBe(true);
    expect(isReservedWinName("nul .txt")).toBe(true);
    expect(isReservedWinName("null")).toBe(false);
    expect(winPathProblem("C:\\a\\b.txt")).toBeUndefined();
    expect(winPathProblem("..\\a\\.\\b")).toBeUndefined();
  });
  it("lenient: `\\\\?\\` は読み替え、区切り 1 つで始まるものは根の決まらない絶対パス。検査はしない", () => {
    expect(toPosixForm(abs("\\\\?\\C:\\a\\b", "win", true))).toBe("/C:/a/b");
    expect(toPosixForm(abs("\\\\?\\UNC\\srv\\share\\a", "win", true))).toBe("/UNC/srv/share/a");
    expect(abs("/C:/a/..", "win", true)).toEqual({
      kind: "abs",
      style: "win",
      root: "C:",
      segments: [],
    });
    expect(abs("/foo", "win", true).root).toBe("");
    expect(parsePath("C:\\a\\NUL", "win", { lenient: true }).kind).toBe("abs");
  });
});

describe("joinPath・toPosixForm・toCanonical・toNative・isUnderPath", () => {
  it("つなぐ: 相対パスの `..` は、根より上には行かない。絶対パスは、そのまま", () => {
    const base = abs("C:\\work\\tree", "win");
    const rel = (raw: string) => {
      const p = parsePath(raw, "win");
      if (p.kind === "invalid") throw new Error(raw);
      return p;
    };
    expect(toNative(joinPath(base, rel("src\\a.ts")))).toBe("C:\\work\\tree\\src\\a.ts");
    expect(toNative(joinPath(base, rel("..\\..\\..\\..\\x")))).toBe("C:\\x");
    expect(toNative(joinPath(base, rel("D:\\other")))).toBe("D:\\other");
    const posix = abs("/work/tree", "posix");
    const up = parsePath("../../../x", "posix");
    if (up.kind !== "rel") throw new Error("rel");
    expect(toPosixForm(joinPath(posix, up))).toBe("/x");
  });
  it("形: POSIX の形・比べる用の形（畳む）・ファイルの API に渡す形", () => {
    const p = abs("C:\\Work\\Tree\\É.txt", "win");
    expect(toPosixForm(p)).toBe("/C:/Work/Tree/É.txt");
    expect(toCanonical(p)).toBe("/c:/work/tree/é.txt");
    expect(toCanonical(abs("C:\\Work\\Tree\\E\u0301.txt", "win"))).toBe("/c:/work/tree/é.txt");
    expect(toNative(p)).toBe("C:\\Work\\Tree\\É.txt");
    expect(toNative(abs("C:/", "win"))).toBe("C:\\");
    expect(toNative(abs("\\\\srv\\share", "win"))).toBe("\\\\srv\\share");
    expect(toNative(abs("//srv/share/a/b", "win"))).toBe("\\\\srv\\share\\a\\b");
    expect(toNative(abs("/a/b", "posix"))).toBe("/a/b");
    expect(toNative(abs("/", "posix"))).toBe("/");
    expect(toPosixForm(abs("/", "posix"))).toBe("/");
  });
  it("下にあるか: 要素ごとに比べる（名前の前方一致では当たらない）。大文字小文字は畳む。別のドライブ・別の共有は外", () => {
    const dir = abs("C:\\work\\tree", "win");
    expect(isUnderPath(abs("c:/WORK/tree/a", "win"), dir)).toBe(true);
    expect(isUnderPath(dir, dir)).toBe(true);
    expect(isUnderPath(abs("C:\\work\\tree2\\a", "win"), dir)).toBe(false);
    expect(isUnderPath(abs("C:\\work", "win"), dir)).toBe(false);
    expect(isUnderPath(abs("D:\\work\\tree\\a", "win"), dir)).toBe(false);
    expect(isUnderPath(abs("C:\\a", "win"), abs("C:\\", "win"))).toBe(true);
    expect(isUnderPath(abs("D:\\a", "win"), abs("C:\\", "win"))).toBe(false);
    const share = abs("\\\\srv\\share", "win");
    expect(isUnderPath(abs("\\\\SRV\\Share\\a", "win"), share)).toBe(true);
    expect(isUnderPath(abs("\\\\srv\\other\\a", "win"), share)).toBe(false);
    expect(isUnderPath(abs("/a/b", "posix"), abs("/", "posix"))).toBe(true);
    expect(isUnderPath(abs("/ab", "posix"), abs("/a", "posix"))).toBe(false);
  });
});

describe("resolvePosixForm・isUnderForm（scope.ts が使う、文字列のままの口）", () => {
  it("POSIX: いままでと同じ（`\\` は文字。`..` は根で止まる）", () => {
    expect(resolvePosixForm("/work", "a/../b", "posix")).toBe("/work/b");
    expect(resolvePosixForm("/work", "/x/./y", "posix")).toBe("/x/y");
    expect(resolvePosixForm("/work", "../../../x", "posix")).toBe("/x");
    expect(resolvePosixForm("/work", "a\\b", "posix")).toBe("/work/a\\b");
    expect(resolvePosixForm("/work", "", "posix")).toBe("/work");
  });
  it("Windows: POSIX の形に読み替え、`\\` を区切りにし、根より上には行かない", () => {
    expect(resolvePosixForm("C:\\work", "a\\..\\b", "win")).toBe("/C:/work/b");
    expect(resolvePosixForm("C:\\work", "..\\..\\..\\x", "win")).toBe("/C:/x");
    expect(resolvePosixForm("C:\\work", "D:\\x", "win")).toBe("/D:/x");
    expect(resolvePosixForm("\\\\srv\\share\\w", "..\\..\\x", "win")).toBe("/UNC/srv/share/x");
  });
  it("isUnderForm: 末尾の区切りを外して比べる。根は、すべてを含む", () => {
    expect(isUnderForm("/C:/a/b", "C:\\a\\")).toBe(true);
    expect(isUnderForm("C:\\ab", "C:\\a")).toBe(false);
    expect(isUnderForm("/a", "/")).toBe(true);
  });
});
