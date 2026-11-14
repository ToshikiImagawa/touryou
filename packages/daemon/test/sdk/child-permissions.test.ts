import { readFileSync } from "node:fs";
import { CHILD_MCP_TOOL_NAMES, ownMcpToolOf, ROLE_OPERATIONS } from "@touryou/core";
import { CHILD_BIND_TOOL, toolName } from "@touryou/mcp";
import { describe, expect, it } from "vitest";
import { childAllowList, childToolNames, PLUGIN_NAME } from "../../src/sdk/child-permissions.js";

const scope = (over: Partial<{ w: string[]; c: string[]; f: string[] }> = {}) => ({
  writableLocations: over.w ?? ["src", "docs/notes"],
  forbiddenLocations: over.f ?? ["src/secret"],
  allowedCommands: over.c ?? ["pnpm test", "git status"],
});

const ok = (r: ReturnType<typeof childAllowList>) => {
  if (!r.ok) throw new Error(r.error.cause);
  return r.value;
};

describe("子の許可の一覧（設計 6.2）", () => {
  it("範囲の中の Bash・Edit と、作業ツリーの中の Read・Grep・Glob が入る", () => {
    expect(ok(childAllowList(scope(), [])).allow).toEqual([
      "Bash(pnpm test:*)",
      "Bash(git status:*)",
      "Edit(./src/**)",
      "Edit(./docs/notes/**)",
      "Read(./**)",
      "Grep(./**)",
      "Glob(./**)",
    ]);
  });

  it("禁止の場所と .git は deny に入る（writable が . でも、禁止の場所を守る）", () => {
    const p = ok(childAllowList(scope({ w: ["."] }), []));
    expect(p.allow).toContain("Edit(./**)");
    expect(p.deny).toEqual([
      "Edit(./.git)",
      "Read(./.git)",
      "Edit(./.git/**)",
      "Read(./.git/**)",
      "Edit(./src/secret)",
      "Read(./src/secret)",
      "Edit(./src/secret/**)",
      "Read(./src/secret/**)",
    ]);
  });

  it("作業ツリーの外の禁止の場所は deny に書けないので入れない（フックが守る）。危ない文字の禁止の場所は失敗", () => {
    expect(ok(childAllowList(scope({ f: ["/etc", "../x"] }), [])).deny).toEqual([
      "Edit(./.git)",
      "Read(./.git)",
      "Edit(./.git/**)",
      "Read(./.git/**)",
    ]);
    expect(childAllowList(scope({ f: ["src/*.env"] }), []).ok).toBe(false);
    expect(childAllowList(scope({ f: ["."] }), []).ok).toBe(false);
  });

  it("ファイルの禁止（.env・作業ツリーの .git ファイル）にも当たる形（./<f>）を入れる", () => {
    const d = ok(childAllowList(scope({ f: [".env", "src/secret.ts"] }), [])).deny;
    for (const f of [".git", ".env", "src/secret.ts"]) {
      for (const t of ["Edit", "Read"]) expect(d).toContain(`${t}(./${f})`);
    }
  });

  it.each([
    "bash -lc",
    "sh x.sh",
    "env FOO=1",
    "xargs rm",
    "node script.js",
    "python3 x.py",
    "npx tsc",
    "sudo ls",
    "npm exec foo",
    "pnpm dlx foo",
    "node -e",
    "perl -e",
    "pnpm x foo",
    "git config core.pager",
    "git -c core.pager=x",
    "find . -exec rm",
    "find . -delete",
    "pnpm run",
    "npm run",
    "/usr/bin/node -e",
    "./node_modules/.bin/tsx x",
    "tsx x.ts",
    "ts-node x",
    "php x",
    "lua x",
    "awk {}",
    "gawk x",
    "make build",
    "git submodule foreach",
  ])("任意のコードを動かせる形は失敗: %j", (c) => {
    expect(childAllowList(scope({ c: [c] }), []).ok).toBe(false);
  });

  it("スクリプトの名前まで書いた run・ふつうの 2 語のコマンドは入る", () => {
    const a = ok(
      childAllowList(scope({ c: ["pnpm run build", "git add", "find . -name"] }), []),
    ).allow;
    expect(a).toEqual(
      expect.arrayContaining(["Bash(pnpm run build:*)", "Bash(git add:*)", "Bash(find . -name:*)"]),
    );
  });

  it("範囲の外のものは入らない（ほかの MCP・WebFetch・cd・任意の Bash）", () => {
    const a = ok(childAllowList(scope(), childToolNames())).allow;
    expect(a.some((x) => x.startsWith("WebFetch") || x === "Bash" || x.startsWith("Bash(cd"))).toBe(
      false,
    );
    expect(
      a
        .filter((x) => x.startsWith("mcp__"))
        .every((x) => /^mcp__(node|plugin_touryou_node)__/.test(x)),
    ).toBe(true);
    expect(a.some((x) => x.includes("secret"))).toBe(false);
  });

  it("道具の名前は 2 つの形（mcp__node__ と mcp__plugin_<名前>_node__）。子のロールの道具を全部持つ", () => {
    const a = ok(childAllowList(scope({ w: [], c: [] }), childToolNames())).allow;
    for (const t of [
      "child_bind",
      "whoami",
      "inbox_fetch",
      "report_progress",
      "report_done",
      "scope_extend",
    ]) {
      expect(a).toContain(`mcp__node__${t}`);
      expect(a).toContain(`mcp__plugin_${PLUGIN_NAME}_node__${t}`);
    }
  });

  it("道具の一覧は core の CHILD_MCP_TOOL_NAMES と、mcp が子に出す名前（toolName の変換）の両方と等しい", () => {
    expect([...childToolNames()]).toEqual([...CHILD_MCP_TOOL_NAMES]);
    expect([...CHILD_MCP_TOOL_NAMES].sort()).toEqual(
      [CHILD_BIND_TOOL, "whoami", ...ROLE_OPERATIONS.child.map(toolName)].sort(),
    );
  });

  it("一覧の mcp の名前は、どれもフックの ownMcpToolOf で touryou の道具と分かる", () => {
    const a = ok(childAllowList(scope({ w: [], c: [] }), childToolNames())).allow;
    for (const n of a.filter((x) => x.startsWith("mcp__"))) {
      expect(CHILD_MCP_TOOL_NAMES).toContain(ownMcpToolOf(n));
    }
  });

  it("plugin の名前は plugin.json の name と一致する", () => {
    const j = JSON.parse(
      readFileSync(
        new URL("../../../../plugin/.claude-plugin/plugin.json", import.meta.url),
        "utf8",
      ),
    ) as { name: string };
    expect(PLUGIN_NAME).toBe(j.name);
  });

  it.each([
    "pnpm test *",
    "git status; curl x",
    "a && b",
    "a | b",
    "echo `id`",
    "echo $HOME",
    "git log > ../x",
    "git log < x",
    'echo "x"',
    "echo 'x'",
    "echo a\\b",
    "a\nb",
    "cd",
    "cd /tmp",
    "  ",
    "a(b)",
    "git",
    "node",
    "npx",
    "bash",
    "make",
  ])("危ない・広すぎるコマンドは失敗: %j", (c) => {
    const r = childAllowList(scope({ c: [c] }), []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalidScope");
  });

  it("空白は 1 つにそろえる", () => {
    expect(ok(childAllowList(scope({ c: ["  git   status "] }), [])).allow).toContain(
      "Bash(git status:*)",
    );
  });

  it.each(["/etc", "../x", "a/../../b", "a*", "a)", "a>b"])(
    "作業ツリーの外・不正な書き込みの場所は失敗: %j",
    (w) => {
      expect(childAllowList(scope({ w: [w] }), []).ok).toBe(false);
    },
  );

  it("`.` は作業ツリー全体（./**）。`a/./b/..` は畳む", () => {
    expect(ok(childAllowList(scope({ w: [".", "a/./b/.."], c: [] }), [])).allow).toEqual([
      "Edit(./**)",
      "Edit(./a/**)",
      "Read(./**)",
      "Grep(./**)",
      "Glob(./**)",
    ]);
  });

  it("Write(...) は allow・deny のどちらにも入れない（書く道具の規則は Edit(...) で照合される）", () => {
    const v = ok(childAllowList(scope(), ["whoami"]));
    expect([...v.allow, ...v.deny].some((r) => r.startsWith("Write("))).toBe(false);
    expect(v.deny).toContain("Edit(./.git)");
  });
});
