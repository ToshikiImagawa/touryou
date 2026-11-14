// .github/workflows の ci.yml・ci-macos.yml・dist-smoke.yml の形を確かめる（macOS の runner の費用を抑える決めごと）。
// `node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), "utf8");
const ci = read("ci.yml");
const mac = read("ci-macos.yml");
const dist = read("dist-smoke.yml");

/** `on.<event>.<key>:` の一覧（2 字下げのイベント、4 字下げのキー、6 字下げの「- "…"」）。 */
function list(src, event, key) {
  const m = new RegExp(`\\n  ${event}:\\n(?:    .*\\n)*?    ${key}:\\n((?:      - .*\\n)+)`).exec(
    src,
  );
  assert.ok(m, `on.${event}.${key} がない`);
  return m[1]
    .trim()
    .split("\n")
    .map((l) => l.replace(/^\s*- /, "").replace(/^"|"$/g, ""));
}

/** GitHub の paths の形（** と *）だけを扱う簡単な照合。 */
const glob = (pattern) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "@@")
      .replace(/\*/g, "[^/]*")
      .replace(/@@/g, ".*")}$`,
  );
const matches = (patterns, file) => patterns.some((p) => glob(p).test(file));

const DOCS_ONLY = [
  "docs/release.md",
  "docs/plugin.md",
  ".sdd/task/initial-spec-design/tasks.md",
  "CHANGELOG.md",
  "README.md",
  "LICENSE",
];
const CODE = [
  "packages/cli/src/launchd.ts",
  "scripts/check.sh",
  "plugin/commands/setup.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "biome.json",
  "tsconfig.base.json",
  ".github/workflows/ci-macos.yml",
];

test("ci.yml は ubuntu だけ（macOS は ci-macos.yml）", () => {
  assert.doesNotMatch(ci, /os: macos|runs-on: macos/);
  assert.match(mac, /runs-on: macos-15\b/);
});

test("ci-macos.yml: push・pull_request とも paths があり、同じ一覧。コードの変更で動き、docs だけでは動かない", () => {
  const push = list(mac, "push", "paths");
  const pr = list(mac, "pull_request", "paths");
  assert.deepEqual(push, pr);
  for (const f of CODE) assert.ok(matches(pr, f), `${f} で動くこと`);
  for (const f of DOCS_ONLY) assert.ok(!matches(pr, f), `${f} だけでは動かないこと`);
});

test("ci.yml: push・pull_request とも paths-ignore で docs・.sdd・CHANGELOG・README・LICENSE だけの変更を外す。コードの変更では動く", () => {
  const push = list(ci, "push", "paths-ignore");
  const pr = list(ci, "pull_request", "paths-ignore");
  assert.deepEqual(push, pr);
  for (const f of DOCS_ONLY) assert.ok(matches(pr, f), `${f} は外すこと`);
  for (const f of CODE) assert.ok(!matches(pr, f), `${f} では動くこと`);
});

test("ci.yml・ci-macos.yml・dist-smoke.yml は、同じ ref の前の実行を止める（concurrency・cancel-in-progress）", () => {
  for (const [name, src] of [
    ["ci.yml", ci],
    ["ci-macos.yml", mac],
    ["dist-smoke.yml", dist],
  ]) {
    assert.match(
      src,
      /\nconcurrency:\n {2}group: .*\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/,
      name,
    );
  }
  const groups = [ci, mac, dist].map((s) => /\n {2}group: (.*)\n/.exec(s)?.[1]);
  assert.equal(new Set(groups).size, 3, "concurrency の group が、ワークフローごとに違うこと");
});
