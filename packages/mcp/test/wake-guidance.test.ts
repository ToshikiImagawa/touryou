import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toolsFor } from "../src/tools.js";

const skill = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../plugin/skills/${name}/SKILL.md`, import.meta.url)),
    "utf8",
  );

describe("progress では親は起きない、の案内", () => {
  it("report_progress の説明に、待つなら report_decision とある", () => {
    const d = toolsFor("child").find((t) => t.name === "report_progress")?.description ?? "";
    expect(d).toContain("親は起きない");
    expect(d).toContain("report_decision");
  });
  it("子の skill に、待つなら report_decision、/setup・/start を勧めない、とある", () => {
    const s = skill("child");
    expect(s).toContain("`report_progress` ではなく `report_decision`");
    expect(s).toContain("勧めない・使わない");
  });
  it("親の skill に、progress では起こされない、とある", () => {
    expect(skill("integrator")).toContain("進捗（progress）では起こされない");
  });
});
