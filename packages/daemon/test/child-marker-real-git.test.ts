import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHILD_WORKTREE_MARKER, createGitPorts, nodeGit } from "../src/git-ports.js";

// 子の作業ツリーの印: 作業ツリーを作ると、その git のディレクトリにノードの ID だけの印を置く。追跡されない。
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

describe("子の作業ツリーの印", () => {
  it("provisionWorktree が、作業ツリーの git のディレクトリに印を置く。元のリポジトリには置かない", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "touryou-marker-")));
    const repoRoot = join(base, "repo");
    const worktreeRoot = join(base, "worktrees");
    mkdirSync(repoRoot);
    mkdirSync(worktreeRoot);
    git(repoRoot, "init", "-q", "-b", "main");
    writeFileSync(join(repoRoot, "a.txt"), "a\n");
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-q", "-m", "init");
    const made = createGitPorts(
      { repoRoot, worktreeRoot, rootCwd: repoRoot, rootNodeId: "root" },
      nodeGit,
    );
    if (!made.ok) throw new Error(made.error.cause);
    const p = await made.value.provisionWorktree({ parentId: "root", nodeId: "c1" });
    if (!p.ok) throw new Error(p.error.cause);
    const wt = p.value.worktreePath;
    const dir = git(wt, "rev-parse", "--absolute-git-dir");
    expect(readFileSync(join(dir, CHILD_WORKTREE_MARKER), "utf8").trim()).toBe("c1");
    expect(git(wt, "status", "--porcelain")).toBe("");
    const rootDir = git(repoRoot, "rev-parse", "--absolute-git-dir");
    expect(() => readFileSync(join(rootDir, CHILD_WORKTREE_MARKER))).toThrow();
  });
});
