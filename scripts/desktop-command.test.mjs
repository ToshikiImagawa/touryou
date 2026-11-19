// plugin/commands/desktop.md（/touryou:desktop）の文言と、照合のコマンドの動きを守る。`node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildChecksums } from "./make-checksums.mjs";
import { DIST_ONLY } from "./test-platform.mjs";

const text = readFileSync(new URL("../plugin/commands/desktop.md", import.meta.url), "utf8");
const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
assert.ok(front, "frontmatter がない");
const body = text.slice(front[0].length);
const rules = /## 進め方の決まり\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
const step = (n) =>
  new RegExp(`\\n${n}\\. \\*\\*([\\s\\S]*?)(?=\\n\\d+\\. \\*\\*|\\n## )`).exec(body)?.[1] ?? "";
const VERIFY =
  'grep -A3 \'"mcpb"\' "<P>/checksums.json" | grep -c -F "\\"sha256\\": \\"$(shasum -a 256 "$HOME/.touryou/work/<name>" | cut -d\' \' -f1)\\"" && ls -l@ "$HOME/.touryou/work/<name>"';

test("allowed-tools は Read だけ（Bash などを事前に許可しない）", () => {
  assert.match(front[1], /^allowed-tools: Read$/m);
});

test("取得は /setup と同じ curl と取得元。書き込み先は $HOME/.touryou/work の下だけ", () => {
  const s = step(3);
  assert.ok(
    s.includes(
      '`mkdir -p "$HOME/.touryou/work" && curl -fL --proto \'=https\' --proto-redir \'=https\' -o "$HOME/.touryou/work/<name>" "https://github.com/comcreate/touryou/releases/download/v<版>/<name>"`',
    ),
  );
  assert.doesNotMatch(s, /\bgh\b/);
  assert.match(step(2), /`repository` が、`https:\/\/github\.com\/comcreate\/touryou`/);
  assert.match(step(2), /`touryou-mcp-<版>\.mcpb`/);
});

test("照合はシェルが計算し、quarantine は外さない。open は「はい」のあとだけ", () => {
  assert.ok(step(4).includes(`\`${VERIFY}\``), "手順 4 のコマンドが違う");
  assert.match(rules, /sha256 は、シェルが計算して照合する/);
  assert.match(rules, /quarantine は\*\*外さない\*\*/);
  assert.match(
    rules,
    /`open` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ実行する。承認ダイアログの許可だけでは実行しない/,
  );
  assert.match(step(5), /はっきり「はい」のときだけ/);
  assert.match(step(5), /それ以外[^。]*は、何もせずに終わる/);
  assert.ok(step(6).includes('`open "$HOME/.touryou/work/<name>"`'));
  assert.doesNotMatch(body, /xattr -d|xattr -c|xattr -r/);
});

test("open で導入の画面が出ないときの予備（Finder・設定 > 拡張機能 > 詳細設定 > 拡張機能をインストール）を伝える", () => {
  assert.match(step(6), /Finder/);
  assert.match(step(6), /設定 > 拡張機能 > 詳細設定 > 拡張機能をインストール/);
});

test("デスクトップアプリがないときは何もしない。daemon の版の食い違い・未配置は止めずに伝える", () => {
  const s = step(1);
  assert.ok(
    s.includes(
      `\`uname -sm; osascript -e 'id of app "Claude"' || echo NOAPP; readlink "$HOME/.touryou/current"\``,
    ),
  );
  assert.match(s, /`NOAPP` が出たら[^\n]*何もせずに終わる/);
  assert.match(s, /\*\*違っても、ない（`\/setup` をまだしていない）ときも、止めない\*\*/);
});

/** 手順 4 を、make-checksums の出力に対して実際に動かす（ls -l@ は Linux にないので、照合の部分だけ）。 */
function verify(mcpbBytes, tarBytes = "tar") {
  const dir = mkdtempSync(join(tmpdir(), "touryou-desktop-"));
  try {
    const home = join(dir, "home");
    const P = join(dir, "plugin");
    const dist = join(dir, "dist");
    for (const d of [join(home, ".touryou", "work"), P, dist]) mkdirSync(d, { recursive: true });
    const v = "9.9.9";
    const sha = (b) =>
      spawnSync("shasum", ["-a", "256"], { input: b, encoding: "utf8" }).stdout.split(" ")[0];
    writeFileSync(
      join(dist, `touryou-${v}-darwin-arm64.tar.gz.sha256`),
      `${sha(tarBytes)}  touryou-${v}-darwin-arm64.tar.gz\n`,
    );
    writeFileSync(
      join(dist, `touryou-mcp-${v}.mcpb.sha256`),
      `${sha("mcpb")}  touryou-mcp-${v}.mcpb\n`,
    );
    const json = buildChecksums({ version: v, read: (f) => readFileSync(join(dist, f), "utf8") });
    writeFileSync(join(P, "checksums.json"), `${JSON.stringify(json, null, 2)}\n`);
    writeFileSync(join(home, ".touryou", "work", `touryou-mcp-${v}.mcpb`), mcpbBytes);
    const cmd = VERIFY.replace(' && ls -l@ "$HOME/.touryou/work/<name>"', "")
      .replaceAll("<P>", P)
      .replaceAll("<name>", `touryou-mcp-${v}.mcpb`);
    return spawnSync("bash", ["-c", cmd], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// shasum・ls -l@ は macOS のコマンド
test("手順 4（実行）: .mcpb の sha256 が一致するときだけ 1。違う・tar.gz の中身を .mcpb の名前で置いたときは止まる", {
  skip: DIST_ONLY,
}, () => {
  const ok = verify("mcpb");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "1\n");
  assert.equal(verify("evil").status, 1);
  // tar.gz の sha256 とは一致させない（extensions.mcpb の項目だけと照合する）
  assert.equal(verify("tar", "tar").status, 1);
});

test("update: 導入の画面の「更新」で古い版が置き換わると伝える", () => {
  assert.match(
    step(5),
    /『更新』と出ます。押すと古い版が置き換わります（同じ名前の拡張機能は 1 つだけになります）/,
  );
  assert.doesNotMatch(body, /まだ確かめていません/);
});

test("NFR_012: 絶対パス・個人の値を書かない", () => {
  assert.doesNotMatch(body, /\/Users\/|\/home\/|~\//);
});
