// dist-smoke-hook.sh（配布物の smoke の、touryou hook の部分）を、Linux の CI でも動かす。
// 配布物の起動口と同じ形（/bin/sh から node を絶対パスで exec する）の起動口を、ビルドした cli（packages/cli/dist/bin.js）に向けて作る。
// PATH は /usr/bin:/bin に絞る（node が PATH になくても動くこと）。check.sh の build の後に動く。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const binJs = join(root, "packages/cli/dist/bin.js");

test("dist-smoke-hook.sh: touryou hook の本体は、環境変数なしで何も出さずに 0、届かなければ 2", {
  skip: !existsSync(binJs) && "cli が未ビルド",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "touryou-smoke-hook-"));
  try {
    const launcher = join(dir, "touryou");
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(binJs)} "$@"\n`,
    );
    chmodSync(launcher, 0o755);
    const r = spawnSync("bash", [join(root, "scripts/dist-smoke-hook.sh"), launcher], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /touryou hook OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dist-smoke.sh: 後片付けで kill 0（プロセスのグループ全体への SIGTERM）にならない", () => {
  const s = readFileSync(join(root, "scripts/dist-smoke.sh"), "utf8");
  assert.doesNotMatch(s, /kill "\$\{pid:-0\}"/);
  assert.match(s, /dist-smoke-hook\.sh/);
});
