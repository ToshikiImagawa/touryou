// scripts/make-checksums.mjs と、release.yml の許可リスト（checksums.json の 1 件だけ追加）の試験。`node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildChecksums, parseSha256File } from "./make-checksums.mjs";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const files = (v) => ({
  [`touryou-${v}-darwin-arm64.tar.gz.sha256`]: `${HEX_A}  touryou-${v}-darwin-arm64.tar.gz\n`,
  // x64 は対象外。混ざっていても、読まない（読まれたら、下の試験が失敗する）
  [`touryou-${v}-darwin-x86_64.tar.gz.sha256`]: `${HEX_B}  touryou-${v}-darwin-x86_64.tar.gz\n`,
  // デスクトップアプリの拡張機能
  [`touryou-mcp-${v}.mcpb.sha256`]: `${HEX_C}  touryou-mcp-${v}.mcpb\n`,
});

test("arm64 の .sha256 から、版・名前・sha256 を作る。assets は darwin-arm64 だけ", () => {
  const f = files("0.1.0");
  const r = buildChecksums({ version: "0.1.0", read: (n) => f[n] });
  assert.deepEqual(r, {
    version: "0.1.0",
    assets: {
      "darwin-arm64": { name: "touryou-0.1.0-darwin-arm64.tar.gz", sha256: HEX_A },
    },
    extensions: { mcpb: { name: "touryou-mcp-0.1.0.mcpb", sha256: HEX_C } },
  });
});

test(".mcpb の .sha256 が欠けている・中の名前が違うと、失敗する", () => {
  const f = files("0.1.0");
  assert.throws(
    () =>
      buildChecksums({
        version: "0.1.0",
        read: (n) => {
          if (n.endsWith(".mcpb.sha256")) throw new Error("ない");
          return f[n];
        },
      }),
    /ない/,
  );
  assert.throws(
    () =>
      buildChecksums({
        version: "0.1.0",
        read: (n) => (n.endsWith(".mcpb.sha256") ? `${HEX_C}  touryou-mcp-0.0.9.mcpb\n` : f[n]),
      }),
    /ファイル名が違う/,
  );
});

test("x64（x86_64）の .sha256 が混ざっても、読まない・assets に入れない", () => {
  const f = files("0.1.0");
  const asked = [];
  const r = buildChecksums({
    version: "0.1.0",
    read: (n) => {
      asked.push(n);
      return f[n];
    },
  });
  assert.deepEqual(asked, [
    "touryou-0.1.0-darwin-arm64.tar.gz.sha256",
    "touryou-mcp-0.1.0.mcpb.sha256",
  ]);
  assert.equal(r.assets["darwin-x86_64"], undefined);
});

test("arm64 の .sha256 が欠けていれば、失敗する（x64 だけでは足りない）", () => {
  const f = files("0.1.0");
  assert.throws(
    () =>
      buildChecksums({
        version: "0.1.0",
        read: (n) => {
          if (n.includes("arm64")) throw new Error("ない");
          return f[n];
        },
      }),
    /ない/,
  );
});

test("pre-release の版（-beta.1）でも作れる", () => {
  const f = files("0.1.0-beta.2");
  const r = buildChecksums({ version: "0.1.0-beta.2", read: (n) => f[n] });
  assert.equal(r.assets["darwin-arm64"].name, "touryou-0.1.0-beta.2-darwin-arm64.tar.gz");
});

test("形が違う・名前が違う・欠けている・版が不正のどれでも、失敗する", () => {
  const f = files("0.1.0");
  assert.throws(
    () => buildChecksums({ version: "0.1.0", read: () => "zzz  x\n" }),
    /形が正しくない/,
  );
  assert.throws(
    () =>
      buildChecksums({ version: "0.1.0", read: (n) => f[n].replace("tar.gz\n", "tar.gz.evil\n") }),
    /ファイル名が違う/,
  );
  assert.throws(
    () =>
      buildChecksums({
        version: "0.1.0",
        read: () => {
          throw new Error("ない");
        },
      }),
    /ない/,
  );
  assert.throws(() => buildChecksums({ version: "../x", read: (n) => f[n] }), /版の形/);
  assert.throws(() => parseSha256File(`${HEX_A}  ../evil\n`), /形が正しくない/);
});

test("release.yml の許可リストは、checksums.json を（ルート直下の 1 件だけ）許し、ほかの種類は許さない", () => {
  const yml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "release.yml"),
    "utf8",
  );
  const m = /grep -Ev '([^']+)'/.exec(yml);
  assert.ok(m, "許可リストの正規表現が見つからない");
  const re = new RegExp(m[1]);
  for (const ok of [
    ".claude-plugin/plugin.json",
    ".mcp.json",
    "hooks/hooks.json",
    "skills/child/SKILL.md",
    "commands/start.md",
    "checksums.json",
  ])
    assert.ok(re.test(ok), `許可される: ${ok}`);
  for (const ng of [
    "node_modules/x.js",
    ".env",
    "bin/node",
    "checksums.json.bak",
    "sub/checksums.json",
    "hooks/evil.mjs",
    "hooks/touryou-hook.mjs", // 削除した旧ファイル。zip に入っていたら、許可リストが弾く（意図した「許可されない」例）
    "touryou-0.1.0-darwin-arm64.tar.gz",
  ]) {
    assert.ok(!re.test(ng), `許可されない: ${ng}`);
  }
});

test("release.yml は、改行を含む名前のファイルを、zip に入れる前に弾く（行ごとの許可リストをすり抜けさせない）", () => {
  const yml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "release.yml"),
    "utf8",
  );
  const m = /if \[ -n "\$\(find plugin -name \$'\*\\n\*' -print -quit\)" \]/.exec(yml);
  assert.ok(m, "改行を含む名前の検査が release.yml にない");
  const dir = mkdtempSync(join(tmpdir(), "zipnl-"));
  try {
    mkdirSync(join(dir, "plugin"));
    const probe = `cd "${dir}" && [ -n "$(find plugin -name $'*\\n*' -print -quit)" ] && echo found || echo none`;
    assert.equal(spawnSync("bash", ["-c", probe], { encoding: "utf8" }).stdout.trim(), "none");
    writeFileSync(join(dir, "plugin", "evil\nchecksums.json"), "x");
    assert.equal(spawnSync("bash", ["-c", probe], { encoding: "utf8" }).stdout.trim(), "found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
