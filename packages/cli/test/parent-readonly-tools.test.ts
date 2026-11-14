import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PARENT_READONLY_TOOL_NAMES, pluginToolName, ROLE_OPERATIONS } from "@touryou/core";
import { describe, expect, it } from "vitest";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");

/** 統合の mcp の道具の名前（mcp の toolName と同じ変換）。 */
const INTEGRATOR_TOOLS = new Set([
  "whoami",
  ...ROLE_OPERATIONS.integrator.map((op) => op.replaceAll(".", "_")),
]);

describe("親の、読むだけの道具の Allow の例（PARENT_READONLY_TOOL_NAMES）", () => {
  it("一覧は 7 つで、どれも統合の道具にある。ものを変える道具・parent_request は入らない", () => {
    expect([...PARENT_READONLY_TOOL_NAMES].sort()).toEqual(
      [
        "whoami",
        "inbox_fetch",
        "tree_list",
        "node_capabilities",
        "decision_get",
        "report_get",
        "node_reclaimPreview",
      ].sort(),
    );
    for (const t of PARENT_READONLY_TOOL_NAMES) expect(INTEGRATOR_TOOLS.has(t), t).toBe(true);
    for (const t of [
      "parent_request",
      "node_spawn",
      "node_stop",
      "node_reclaim",
      "node_bindCode",
    ]) {
      expect(PARENT_READONLY_TOOL_NAMES).not.toContain(t);
    }
  });

  it("/setup の案内の例は、一覧の plugin の名前とちょうど同じ", () => {
    const setup = read("plugin/commands/setup.md");
    const listed = [...setup.matchAll(/"(mcp__plugin_[^"]+_node__[A-Za-z_]+)"/g)].map((m) => m[1]);
    expect([...new Set(listed)].sort()).toEqual(
      PARENT_READONLY_TOOL_NAMES.map(pluginToolName).sort(),
    );
    expect(setup).toContain("/permissions");
    expect(setup).toContain("parent_request");
  });

  it("docs/plugin.md は、一覧の 7 つを全部あげる", () => {
    const doc = read("docs/plugin.md");
    for (const t of PARENT_READONLY_TOOL_NAMES) expect(doc, t).toContain(`\`${t}\``);
    expect(doc).toContain("PARENT_READONLY_TOOL_NAMES");
  });
});
