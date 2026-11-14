import type { Scope } from "@touryou/core";
import { describe, expect, it } from "vitest";
import { decideToolUse } from "../../src/sdk/hook-policy.js";

/**
 * CLI の子（`claude --bg`）の判定で、daemon の state のディレクトリ（root-token・記録の DB）を、読み取り・書き込みとも
 * 禁じる。compose.ts の decideCliHook と同じ形（roots は daemon の設定の stateDir〔と設定ファイル〕、allow は空）で渡す。
 */
const S = "/home/u/state";
const WT = "/home/u/wt/a";
const scope: Scope = {
  writableLocations: [WT],
  forbiddenLocations: [],
  allowedCommands: ["cat", "echo"],
};
const prot = {
  roots: [
    { path: S, kind: "stateDir" as const },
    { path: "/home/u/.touryou/config.json", kind: "daemonConfig" as const },
  ],
  allow: [] as string[],
  home: "/home/u",
  worktree: WT,
};
const resolve = async (p: string) => (await import("node:path")).posix.resolve(p);
const subjectOf = async (tool: string, input: unknown) => {
  const r = await decideToolUse(scope, WT, tool, input, resolve, prot, WT);
  return r.allow ? null : (r.violation?.subject ?? r.violation?.reason ?? "denied");
};

describe("CLI の子: state のディレクトリは読み取り・書き込みとも禁止", () => {
  it("Read で <stateDir>/root-token を読むと拒否", async () => {
    expect(await subjectOf("Read", { file_path: `${S}/root-token` })).toBe("protected:stateDir");
  });

  it("Bash の cat <stateDir>/root-token は拒否（相対・.. を通っても）", async () => {
    expect(await subjectOf("Bash", { command: `cat ${S}/root-token` })).toBe("protected:stateDir");
    expect(await subjectOf("Bash", { command: "cat ../../state/root-token" })).toBe(
      "protected:stateDir",
    );
  });

  it("Grep・Glob で state のディレクトリを探すと拒否", async () => {
    expect(await subjectOf("Grep", { pattern: "x", path: S })).toBe("protected:stateDir");
    expect(await subjectOf("Glob", { pattern: `${S}/*` })).toBe("protected:stateDir");
  });

  it("書き込み（Write・Bash のリダイレクト）も拒否", async () => {
    expect(await subjectOf("Write", { file_path: `${S}/root-token`, content: "x" })).not.toBeNull();
    expect(await subjectOf("Bash", { command: `echo x > ${S}/root-token` })).not.toBeNull();
  });

  it("daemon の設定ファイルも読めない。作業ツリーの中は今までどおり読める", async () => {
    expect(await subjectOf("Read", { file_path: "/home/u/.touryou/config.json" })).toBe(
      "protected:daemonConfig",
    );
    expect(await subjectOf("Read", { file_path: `${WT}/README.md` })).toBeNull();
  });
});

describe("CLI の子: 印・作業ツリーの git のディレクトリ・<作業ツリー>/.git は、書き込み・削除を禁止", () => {
  const G = "/home/u/repo/.git/worktrees/a";
  const scopeRm: Scope = {
    writableLocations: [WT],
    forbiddenLocations: [],
    allowedCommands: ["cat", "echo", "rm", "mv", "ln", "cp", "touch", "git"],
  };
  // compose.ts の decideCliHook と同じ形: writeDenied に git のディレクトリと <作業ツリー>/.git
  const protG = { ...prot, writeDenied: [G, `${WT}/.git`] };
  const allowed = async (tool: string, input: unknown) =>
    (await decideToolUse(scopeRm, WT, tool, input, resolve, protG, WT)).allow;

  it.each([
    ["Write", { file_path: `${G}/touryou-child`, content: "x" }],
    ["Edit", { file_path: `${G}/HEAD`, old_string: "a", new_string: "b" }],
    ["Write", { file_path: `${WT}/.git`, content: "gitdir: /elsewhere" }],
  ])("%s %j は拒否", async (tool, input) => {
    expect(await allowed(tool, input)).toBe(false);
  });

  it.each([
    `rm ${G}/touryou-child`,
    `rm -rf ${G}`,
    `mv ${G}/touryou-child /tmp/x`,
    `ln -sf /tmp/x ${G}/touryou-child`,
    `echo x > ${G}/touryou-child`,
    `cp /tmp/x ${G}/touryou-child`,
    "rm .git",
    "echo gitdir: /x > .git",
    "mv .git .git.bak",
  ])("Bash %s は拒否", async (command) => {
    expect(await allowed("Bash", { command })).toBe(false);
  });

  it("作業ツリーのふつうのファイルの削除・git の操作は、今までどおり通る", async () => {
    expect(await allowed("Bash", { command: "rm src/old.ts" })).toBe(true);
    expect(await allowed("Bash", { command: "git status" })).toBe(true);
    expect(await allowed("Write", { file_path: `${WT}/src/a.ts`, content: "x" })).toBe(true);
  });
});

describe("CLI の子: Bash の抜け道と git clean", () => {
  const G = "/home/u/repo/.git/worktrees/a";
  const scopeAll: Scope = {
    writableLocations: [WT],
    forbiddenLocations: [],
    allowedCommands: ["dd", "curl", "tee", "sed", "cp", "install", "truncate", "git", "echo"],
  };
  const protG = { ...prot, writeDenied: [G, `${WT}/.git`] };
  const allowed = async (command: string) =>
    (await decideToolUse(scopeAll, WT, "Bash", { command }, resolve, protG, WT)).allow;

  it.each([
    `dd if=/dev/zero of=${G}/touryou-child`,
    `curl --output=${G}/touryou-child http://127.0.0.1/`,
    `echo x | tee ${G}/touryou-child`,
    `sed -i s/a/b/ ${G}/HEAD`,
    `cp /tmp/x ${G}/touryou-child`,
    `install /tmp/x ${G}/touryou-child`,
    `truncate -s 0 ${G}/touryou-child`,
    "git worktree remove .",
    "git worktree move . /tmp/x",
    "git worktree prune",
  ])("%s は拒否", async (command) => {
    expect(await allowed(command)).toBe(false);
  });

  it("git worktree list・作業ツリーの中の dd・sed -i は通る", async () => {
    expect(await allowed("git worktree list")).toBe(true);
    expect(await allowed(`dd if=/dev/zero of=${WT}/tmp.bin count=1`)).toBe(true);
    expect(await allowed("sed -i s/a/b/ src/a.ts")).toBe(true);
  });

  it("禁じる場所が作業ツリーの外と <作業ツリー>/.git だけなら、git clean・git stash -u は通る", async () => {
    expect(await allowed("git clean -fd")).toBe(true);
    expect(await allowed("git stash -u")).toBe(true);
  });

  it("禁じる場所が作業ツリーの中にある（Desktop の子の .claude/）なら、git clean は拒否のまま", async () => {
    const protD = { ...prot, writeDenied: [`${WT}/.claude`] };
    const d = await decideToolUse(
      scopeAll,
      WT,
      "Bash",
      { command: "git clean -fd" },
      resolve,
      protD,
      WT,
    );
    expect(d.allow).toBe(false);
  });
});

describe("CLI の子: git の大域のオプションですり抜けない", () => {
  const G = "/home/u/repo/.git/worktrees/a";
  const scopeGit: Scope = {
    writableLocations: [WT],
    forbiddenLocations: [],
    allowedCommands: ["git"],
  };
  const protG = { ...prot, writeDenied: [G, `${WT}/.git`] };
  const protD = { ...prot, writeDenied: [`${WT}/.claude`] };
  const allowed = async (command: string, pp = protG) =>
    (await decideToolUse(scopeGit, WT, "Bash", { command }, resolve, pp, WT)).allow;

  it.each([
    "git -C . worktree remove --force .",
    "git -c x=y worktree prune",
    "git --no-pager worktree move . /tmp/x",
    `git --git-dir=${G} status`,
    `git --git-dir ${G} status`,
    "git --work-tree=/tmp status",
    "git -C /tmp status",
    "git -C",
  ])("%s は拒否", async (command) => {
    expect(await allowed(command)).toBe(false);
  });

  it.each([
    "git -C . status",
    "git -c core.pager=cat log",
    "git --no-pager worktree list",
    "git --exec-path",
  ])("%s は通る", async (command) => {
    expect(await allowed(command)).toBe(true);
  });

  it.each(["git -C . clean -fd", "git -c x=y stash -u", "git --no-pager clean -fdx"])(
    "Desktop の子（.claude/ が作業ツリーの中）では、大域のオプションを付けても %s は拒否",
    async (command) => {
      expect(await allowed(command, protD)).toBe(false);
    },
  );
});

describe("CLI の子: git のエイリアスですり抜けない", () => {
  const G = "/home/u/repo/.git/worktrees/a";
  const scopeGit: Scope = {
    writableLocations: [WT],
    forbiddenLocations: [],
    allowedCommands: ["git"],
  };
  const protG = { ...prot, writeDenied: [G, `${WT}/.git`] };
  const allowed = async (command: string) =>
    (await decideToolUse(scopeGit, WT, "Bash", { command }, resolve, protG, WT)).allow;

  it.each([
    "git -c alias.w='worktree prune' w",
    "git -c ALIAS.w=worktree w",
    "git --config-env=alias.w=X w",
    'git config alias.w "worktree prune"',
    "git config --global alias.w '!rm -rf .git'",
    "git config --local alias.w worktree",
    "git config --file /tmp/c alias.w worktree",
    "git config set alias.w worktree",
    "git -c include.path=/tmp/evil.cfg w",
    "git -c includeIf.gitdir:/x/.path=/tmp/evil.cfg status",
    "git -c INCLUDE.PATH=/tmp/x status",
    "git --config-env=include.path=X status",
    "git config include.path /tmp/evil.cfg",
    "git config --global includeIf.gitdir:/x/.path /tmp/evil.cfg",
  ])("%s は拒否", async (command) => {
    expect(await allowed(command)).toBe(false);
  });

  it.each([
    "git config --get alias.w",
    "git config --list",
    "git config user.name x",
    "git -c core.pager=cat log",
  ])("%s は通る", async (command) => {
    expect(await allowed(command)).toBe(true);
  });
});

describe("CLI の子: ほかのノードの git のディレクトリ（.git/worktrees/<ほかの名前>/）は読み取りも禁止", () => {
  const W = "/home/u/repo/.git/worktrees";
  const own = `${W}/a`;
  // compose.ts の decideCliHook と同じ形: roots に <共通の git>/worktrees、allow に自分の git のディレクトリ
  const protO = {
    ...prot,
    roots: [...prot.roots, { path: W, kind: "otherNodeGitDir" as const }],
    allow: [own],
    writeDenied: [own, `${WT}/.git`],
  };
  const subject = async (tool: string, input: unknown) => {
    const r = await decideToolUse(scope, WT, tool, input, resolve, protO, WT);
    return r.allow ? null : (r.violation?.subject ?? "denied");
  };

  it("ほかのノードの紐付けのコードのファイルは、Read・Bash の cat・Grep・Glob で読めない", async () => {
    const other = `${W}/b/touryou-bind-code`;
    expect(await subject("Read", { file_path: other })).toBe("protected:otherNodeGitDir");
    expect(await subject("Bash", { command: `cat ${other}` })).toBe("protected:otherNodeGitDir");
    expect(await subject("Grep", { pattern: "x", path: `${W}/b` })).toBe(
      "protected:otherNodeGitDir",
    );
    expect(await subject("Glob", { pattern: `${W}/*/touryou-bind-code` })).toBe(
      "protected:otherNodeGitDir",
    );
    // 置き場そのもの（祖先）を再帰で探すのも拒否
    expect(await subject("Grep", { pattern: "x", path: W })).toBe("protected:otherNodeGitDir");
  });

  it("自分の git のディレクトリは、読み取りは禁じない（書き込みは今までどおり禁止）", async () => {
    expect(await subject("Read", { file_path: `${own}/HEAD` })).toBeNull();
    expect(await subject("Write", { file_path: `${own}/HEAD`, content: "x" })).not.toBeNull();
  });
});
