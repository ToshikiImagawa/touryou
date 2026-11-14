import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGitPorts,
  GIT_MISSING_MESSAGE,
  isGitMissing,
  makeNodeGit,
} from "../src/git-ports.js";

// git（Xcode の Command Line Tools）がないときの試験。実際の git の代わりに、偽物（ないパス・仮の git を真似たスクリプト）を使う。
// 仮の git の出力・終了コードは、推測（本物の git では確かめていない）。

const base = (): string => realpathSync(mkdtempSync(join(tmpdir(), "touryou-git-missing-")));

/** macOS の仮の git（Command Line Tools がない）を真似る: stderr に xcrun のエラーを出し、終了コード 1。 */
const fakeStub = (dir: string): string => {
  const p = join(dir, "git");
  writeFileSync(
    p,
    '#!/bin/sh\necho "xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun" >&2\nexit 1\n',
  );
  chmodSync(p, 0o755);
  return p;
};

/** ふつうに失敗する git（git がないのではない）を真似る。 */
const fakeOtherFailure = (dir: string): string => {
  const p = join(dir, "git-other");
  writeFileSync(p, '#!/bin/sh\necho "fatal: not a git repository" >&2\nexit 128\n');
  chmodSync(p, 0o755);
  return p;
};

describe("isGitMissing", () => {
  it("ENOENT と、仮の git の出力は、git がないとみなす", () => {
    expect(isGitMissing("ENOENT", "")).toBe(true);
    expect(isGitMissing(1, "xcrun: error: invalid active developer path (x)")).toBe(true);
    expect(
      isGitMissing(1, "xcode-select: note: No developer tools were found, requesting install."),
    ).toBe(true);
  });
  it("Xcode のライセンスに未同意も、git が使えないとみなす", () => {
    expect(
      isGitMissing(
        69,
        "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'",
      ),
    ).toBe(true);
    expect(
      isGitMissing(69, "Agreeing to the Xcode and Apple SDKs license requires admin privileges"),
    ).toBe(true);
  });
  it("cwd がないときの ENOENT は、git がないとみなさない", () => {
    expect(isGitMissing("ENOENT", "spawn git ENOENT", false)).toBe(false);
  });
  it("xcrun: error だけ（仮の git に特有の文言がない）は、git がないとみなさない", () => {
    expect(isGitMissing(1, "hook: xcrun: error: unable to find utility")).toBe(false);
  });
  it("ふつうの git の失敗は、git がないとみなさない", () => {
    expect(isGitMissing(128, "fatal: not a git repository")).toBe(false);
    expect(isGitMissing(1, "error: cannot lock ref")).toBe(false);
  });
});

describe("makeNodeGit（git がない）", () => {
  it("起動できない（ENOENT）: code は null のまま、stderr の先頭に説明が付く", async () => {
    const d = base();
    const r = await makeNodeGit(join(d, "no-such-git"))(["status"], { cwd: d });
    expect(r.code).toBeNull();
    expect(r.stderr.startsWith(GIT_MISSING_MESSAGE)).toBe(true);
    expect(r.stderr).toContain("xcode-select --install");
  });

  it("cwd がない（ENOENT）: git がないとは案内しない（出力を変えない）", async () => {
    const d = base();
    const r = await makeNodeGit(fakeStub(d))(["status"], { cwd: join(d, "gone") });
    expect(r.code).toBeNull();
    expect(r.stderr.startsWith(GIT_MISSING_MESSAGE)).toBe(false);
  });

  it("仮の git: 終了コードはそのまま、stderr の先頭に説明が付き、元の出力も残る", async () => {
    const d = base();
    const r = await makeNodeGit(fakeStub(d))(["status"], { cwd: d });
    expect(r.code).toBe(1);
    expect(r.stderr.startsWith(GIT_MISSING_MESSAGE)).toBe(true);
    expect(r.stderr).toContain("invalid active developer path");
  });

  it("ふつうの git の失敗は、出力を変えない", async () => {
    const d = base();
    const r = await makeNodeGit(fakeOtherFailure(d))(["status"], { cwd: d });
    expect(r.code).toBe(128);
    expect(r.stderr).toBe("fatal: not a git repository\n");
  });

  it("子の作成（provisionWorktree）は、これまでどおり失敗を返し、原因に説明が入る", async () => {
    const d = base();
    const repoRoot = join(d, "repo");
    const worktreeRoot = join(d, "wt");
    mkdirSync(repoRoot);
    mkdirSync(worktreeRoot);
    const made = createGitPorts(
      { repoRoot, worktreeRoot, rootCwd: repoRoot, rootNodeId: "root" },
      makeNodeGit(fakeStub(d)),
    );
    if (!made.ok) throw new Error(made.error.cause);
    const p = await made.value.provisionWorktree({ parentId: "root", nodeId: "c1" });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error.cause).toContain(GIT_MISSING_MESSAGE);
  });
});
