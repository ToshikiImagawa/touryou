// plugin/commands/setup.md の、安全に関わる決まりの試験。`node --test scripts/*.test.mjs`
// - allowed-tools の照合の規則（`:*` の語境界・連結・リダイレクト）は、Claude Code の実装で未確認なので、パターンに頼らない: 事前に許可するのは `Read` だけ。
// - この試験は、**文書の内容**を検査する（モデルが文書どおりに動くことは、試験では保証できない。文書の「進め方の決まり」に明記）。
//   手順 4・5・6 のコマンドは、文書から取り出して、実際にシェルで走らせる。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = readFileSync(join(root, "plugin", "commands", "setup.md"), "utf8");
const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
assert.ok(front, "frontmatter がない");
const allowedLine = /^allowed-tools:\s*(.*)$/m.exec(front[1]);
const body = text.slice(front[0].length);
const rules = /## 進め方の決まり\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
const rest = body.replace(rules, "");

/** 「手順」の節の、手順 N の本文（次の手順の直前まで）。 */
const steps = new Map();
{
  const section = /## 手順\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  for (const p of section.split(/\n(?=\d+\. \*\*)/)) {
    const n = /^(\d+)\. \*\*/.exec(p)?.[1];
    if (n !== undefined) steps.set(Number(n), p);
  }
}
const step = (n) => steps.get(n) ?? "";
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
/** 手順 N の、先頭のコマンド（`…` のコード片のうち、`startsWith` で始まるもの）。 */
const command = (n, startsWith) => {
  const spans = [...step(n).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const c = spans.find((s) => s.startsWith(startsWith));
  assert.ok(c, `手順 ${n} に ${startsWith} で始まるコマンドがない`);
  return c;
};

test("allowed-tools は、Read だけ（Bash・Write・xattr などを、事前に許可しない）", () => {
  assert.ok(allowedLine, "allowed-tools がない");
  assert.deepEqual(
    (allowedLine[1] ?? "").split(",").map((t) => t.trim()),
    ["Read"],
  );
});

test("手順は 1〜9 が、この順で、すべてある。手順の順序（照合 < 展開前の確認 < 展開 < 展開後の確認）", () => {
  assert.deepEqual([...steps.keys()], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const at = (s) => body.indexOf(s);
  assert.ok(
    at("1. **対象の確認") < at("2. **配布物の情報") && at("2. **配布物の情報") < at("3. **取得"),
  );
  assert.ok(at("3. **取得") < at("4. **照合") && at("4. **照合") < at("5. **展開前"));
  assert.ok(at("5. **展開前") < at("6. **展開・配置") && at("6. **展開・配置") < at("7. **展開後"));
  assert.ok(
    at("7. **展開後") < at("8. **設定ファイル") &&
      at("8. **設定ファイル") < at("9. **起動のしかたを選ぶ"),
  );
});

test("手順 1: OS と一緒に、xcode-select -p で Command Line Tools を確かめる（1 コマンド）。git --version は使わず、インストールは実行しない", () => {
  const s1 = steps.get(1);
  assert.match(
    s1,
    /`uname -sm && xcode-select -p && test -x "\$\(xcode-select -p\)\/usr\/bin\/git"`/,
  );
  assert.match(s1, /失敗したら（終了コードが 0 でない）、止まる/);
  assert.match(
    s1,
    /定型文（Command Line Tools がない）: 「[^」]*`xcode-select --install`[^」]*もう一度 \/setup/,
  );
  // git --version は、仮の git を動かして、インストールの画面を出しうる
  assert.doesNotMatch(body.replace(/\*\*`git --version` は、使わない\*\*/, ""), /git --version/);
  // インストールのコマンドは、案内するだけ（コマンドとして実行させない）
  assert.match(s1, /インストール（`xcode-select --install`）は、このコマンドでは実行しない/);
});

test("手順 2: 版の一致・repository の固定値・name の形・sha256 の形を確かめ、決めた plugin のディレクトリを手順 4 でも使う", () => {
  const s = step(2);
  assert.match(s, /`version` と、`plugin\.json` の `version` が同じ/);
  assert.match(s, /`\/`・`\.\.`・空白を含まない/);
  assert.match(s, /16 進の 64 文字/);
  assert.match(s, /一つでも違えば止まる/);
  assert.match(s, /手順 4 でも使う/);
});

test("repository の固定 URL が、plugin.json の repository と、setup.md の取得先・手順 2 で一致する（ずれると、手順 2 で常に止まる）", () => {
  const repo = JSON.parse(
    readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
  ).repository;
  assert.match(repo, /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(step(2).includes(`\`${repo}\``), "手順 2 の固定値が、plugin.json の repository と違う");
  assert.ok(step(3).includes(`"${repo}/releases/download/`), "手順 3 の取得先が違う");
});

test("手順 3: curl（認証なし）で、plugin.json の repository と、release.yml の asset の置き場（v<版>/<name>）から取り、書き込み先は work の下だけ", () => {
  const c = command(3, "mkdir -p");
  assert.equal(
    c,
    'mkdir -p "$HOME/.touryou/work" && curl -fL --proto \'=https\' --proto-redir \'=https\' -o "$HOME/.touryou/work/<name>" "https://github.com/comcreate/touryou/releases/download/v<版>/<name>"',
  );
  const repo = JSON.parse(
    readFileSync(new URL("../plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"),
  ).repository;
  assert.ok(
    c.includes(`"${repo}/releases/download/v<版>/<name>"`),
    "URL が plugin.json の repository と違う",
  );
  // release.yml は、タグ（v<版>）の Release に、checksums.json の name と同じ名前の asset を付ける
  const wf = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(wf, /tags: \["v\*"\]/);
  assert.match(wf, /gh release create "\$\{GITHUB_REF_NAME\}"/);
  assert.match(step(2), /`touryou-<版>-darwin-arm64\.tar\.gz`/);
  assert.match(step(3), /失敗したら（終了コードが 0 でない）、止まる/);
  assert.doesNotMatch(step(3), /\bgh (?:release|auth|api)\b/);
});

test("トークンを出さない: gh auth token・--show-token・GH_TOKEN の設定・Authorization は、「進め方の決まり」の禁止の記述以外に出ない", () => {
  for (const re of [
    /gh auth token/,
    /--show-token/,
    /GH_TOKEN/,
    /Authorization/,
    /\bgh release\b/,
  ]) {
    assert.doesNotMatch(rest, re, `進め方の決まり以外に出てはいけない: ${re}`);
  }
  assert.match(rules, /GitHub のトークンを、出さない・読まない・貼らせない/);
  assert.match(
    rules,
    /`curl` で取得したファイルには、quarantine が付かない[^\n]*\*\*それでも手順 4・7 で、必ず確かめる\*\*/,
  );
});

test("手順 3: 書き込み先は work の下だけ。タイムアウトを長めに・失敗したら同じコマンドを再実行（上書き）と案内する", () => {
  const s = step(3);
  assert.match(s, /`\$HOME\/\.touryou\/work\/` の下だけ/);
  assert.match(s, /タイムアウトを長め（最大 10 分）にして実行する/);
  assert.match(s, /同じコマンドを、もう一度実行する/);
});

test("手順 4 の形: ハッシュはシェルが計算し（$(shasum … | cut)）、grep の終了コードで、ls -l@ に進むか止まるかが決まる", () => {
  const c = command(4, 'grep -c -F "');
  assert.match(
    c,
    /^grep -c -F "\\"sha256\\": \\"\$\(shasum -a 256 "\$HOME\/\.touryou\/work\/<name>" \| cut -d' ' -f1\)\\"" "<P>\/checksums\.json" && ls -l@ "\$HOME\/\.touryou\/work\/<name>"$/,
  );
  assert.match(step(4), /0 件なら（`shasum` の失敗を含む）、展開せずに止まる/);
  assert.match(step(4), /削除しない。次回の取得が、上書きする/);
  assert.match(step(4), /外さずに/);
});

/** 手順 4・5 のコマンドを、実際にシェルで走らせる。`viaCli` なら、checksums.json を、make-checksums.mjs（CLI）の出力にする。 */
const fixture = (sha, files) => {
  const home = mkdtempSync(join(tmpdir(), "touryou-setup-"));
  made.push(home);
  mkdirSync(join(home, ".touryou", "work"), { recursive: true });
  mkdirSync(join(home, "plugin"));
  const f = join(home, ".touryou", "work", "touryou-9.9.9-darwin-arm64.tar.gz");
  // tar.gz を、本物の tar で作る
  const stage = join(home, "stage");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, name)), { recursive: true });
    writeFileSync(join(stage, name), content);
  }
  spawnSync("tar", ["-czf", f, "-C", stage, ...Object.keys(files).map((n) => n.split("/")[0])]);
  const actual = spawnSync("shasum", ["-a", "256", f], { encoding: "utf8" }).stdout.split(" ")[0];
  const claimed = sha === "actual" ? actual : sha;
  writeFileSync(
    join(home, "plugin", "checksums.json"),
    `${JSON.stringify({ version: "9.9.9", assets: { "darwin-arm64": { name: "touryou-9.9.9-darwin-arm64.tar.gz", sha256: claimed } } }, null, 2)}\n`,
  );
  return { home, P: join(home, "plugin") };
};
const sh = (cmd, home, P) =>
  spawnSync(
    "sh",
    [
      "-c",
      cmd
        .replaceAll("<name>", "touryou-9.9.9-darwin-arm64.tar.gz")
        .replaceAll("<P>", P)
        .replaceAll("<版>", "9.9.9")
        // `ls -l@` は、macOS だけのオプション（試験は、Linux でも動くので、拡張属性なしの形に置き換える）
        .replaceAll("ls -lR@", "ls -lR")
        .replaceAll("ls -l@", "ls -l"),
    ],
    { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home }, encoding: "utf8" },
  );
const GOOD = { "touryou-darwin-arm64/bin/touryou": "x", "touryou-darwin-arm64/lib/a.js": "y" };

test("手順 4（実行）: checksums.json の sha256 が一致するときだけ、ls -l@ に進む。一致しない・shasum の失敗（ファイルがない）は、終了コード 1 で止まる", () => {
  const c = command(4, 'grep -c -F "');
  const ok = fixture("actual", GOOD);
  assert.equal(sh(c, ok.home, ok.P).status, 0);
  // checksums.json の値が違う（書き写しの誤り・差し替え）→ 止まる
  const bad = fixture("0".repeat(64), GOOD);
  const r = sh(c, bad.home, bad.P);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /touryou-9\.9\.9/);
  // 取得に失敗してファイルがない → shasum が失敗し、空のハッシュ → 0 件 → 止まる
  const gone = fixture("actual", GOOD);
  rmSync(join(gone.home, ".touryou", "work", "touryou-9.9.9-darwin-arm64.tar.gz"));
  assert.equal(sh(c, gone.home, gone.P).status, 1);
});

test("手順 5（実行）: 想定の中身（先頭が touryou-darwin-arm64/）だけ OK。別の先頭・.. の要素は、OK が出ない", () => {
  const c = command(5, "tar -tzf");
  const run = (files) => {
    const x = fixture("actual", files);
    return sh(c, x.home, x.P);
  };
  assert.match(run(GOOD).stdout, /^OK\n$/);
  assert.doesNotMatch(run({ ...GOOD, "evil/x": "z" }).stdout, /OK/);
  assert.doesNotMatch(run({ "other/bin/touryou": "x" }).stdout, /OK/);
  // `foo..js` のような名前は、誤検出しない
  assert.match(run({ ...GOOD, "touryou-darwin-arm64/lib/foo..js": "z" }).stdout, /OK/);
});

test("手順 5（実行）: シェルの上書き禁止（noclobber。set -C）が有効で、前回の list.txt が残っていても OK が出る（中断のあとのやり直し）", () => {
  const c = command(5, "tar -tzf");
  assert.match(
    c,
    /^tar -tzf "\$HOME\/\.touryou\/work\/<name>" >\| "\$HOME\/\.touryou\/work\/list\.txt"/,
  );
  const x = fixture("actual", GOOD);
  writeFileSync(join(x.home, ".touryou", "work", "list.txt"), "old\n");
  const r = sh(`set -C; ${c}`, x.home, x.P);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^OK\n$/);
  assert.match(rules, /途中で中断したときは、そのまま `\/setup` を最初からやり直してよい/);
  assert.match(rules, /コマンドが失敗したら、書き換えて実行し直さずに止まり/);
});

test("手順 6: current が実ディレクトリなら止まる（リンクの中に作らない）。daemon を止めてから。同じ版の再実行の注意", () => {
  const c = command(6, "{ [ ! -e");
  assert.match(
    c,
    /ln -sfn "\$HOME\/\.touryou\/v<版>\/touryou-darwin-arm64" "\$HOME\/\.touryou\/current"$/,
  );
  assert.match(step(6), /current` が、リンクでない実ディレクトリのときは、最初の確認で止まる/);
  assert.match(step(6), /止めてから/);
  assert.match(step(6), /同じ版の再実行は、上書きで展開する/);
  // 実行: 展開できて、current が向く。実ディレクトリの current があれば、止まる
  const x = fixture("actual", GOOD);
  const r = sh(c, x.home, x.P);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    spawnSync("test", ["-L", join(x.home, ".touryou", "current")]).status,
    0,
    "current がリンクになる",
  );
  const y = fixture("actual", GOOD);
  mkdirSync(join(y.home, ".touryou", "current"), { recursive: true });
  assert.notEqual(sh(c, y.home, y.P).status, 0);
});

test("手順 7: 展開後の quarantine は ls -lR@ で見る（終了コード 1 は正常）。外さずに止まる。--help は daemon を起動しない旨", () => {
  const s = step(7);
  assert.match(s, /ls -lR@/);
  assert.match(s, /終了コード 1 は、「0 件」で、正常/);
  assert.match(s, /外さずに/);
  assert.match(s, /daemon は起動しない/);
});

test('手順 8: 設定ファイル。必須の 5 項目（docs/config.md と一致）・絶対パス（printf %s "$HOME"）・chmod 700/600・Write は 1 か所・git リポジトリの確認・パスの扱い', () => {
  const s = step(8);
  const doc = readFileSync(join(root, "docs", "config.md"), "utf8");
  const required = [
    ...(/## 必須の項目\n([\s\S]*?)\n## /.exec(doc)?.[1] ?? "").matchAll(/^\| `(\w+)` \|/gm),
  ].map((m) => m[1]);
  assert.deepEqual(required, ["stateDir", "repoRoot", "worktreeRoot", "rootCwd", "rootScope"]);
  for (const k of required) assert.ok(s.includes(`"${k}"`), `雛形に ${k} がない`);
  assert.match(s, /printf %s "\$HOME"/);
  assert.match(s, /git -C "<repoRoot>" rev-parse --is-inside-work-tree/);
  assert.match(s, /chmod 700 "<H>\/\.touryou\/state"/);
  assert.match(s, /chmod 600 "<H>\/\.touryou\/config\.json"/);
  assert.match(s, /`<H>\/\.touryou\/config\.json`（\*\*この 1 か所だけ\*\*）/);
  assert.match(s, /"stateDir": "<H>\/\.touryou\/state"/);
  assert.match(s, /トークンの値は、設定ファイルに書かない/);
  assert.doesNotMatch(s, /mcpUrl/);
  assert.match(text, /改行・引用符（`"`・`'`・`` ` ``）・`\$`・`;`・`\\` を含むときは、止まる/);
});

test("危険なコマンドは、「進め方の決まり」以外に出ない（xattr は ls -l@ 以外・rm・eval・bash -c・sudo・spctl・codesign・curl | sh・cat）", () => {
  for (const re of [
    /\bxattr\b/,
    /\bsudo\b/,
    /\brm\s+\S/,
    /\beval\b/,
    /\b(?:ba|z)?sh\s+-c\b/,
    /\bspctl\b/,
    /\bcodesign\b/,
    /curl[^\n]*\|\s*(?:ba|z)?sh\b/,
    /\bcat\b/,
    /chmod\s+-R\b/,
  ]) {
    assert.doesNotMatch(rest, re, `進め方の決まり以外に出てはいけない: ${re}`);
  }
  assert.match(rules, /quarantine を、外さない/);
  assert.match(rules, /`xattr` の書き換え〔`-d`・`-c`・`-w`〕・`sudo`・`rm` は、実行しない/);
  assert.match(rules, /`root-token` などのトークンのファイルは、読まない・出さない/);
  assert.match(rules, /手順 3 の `curl` だけ/);
  assert.doesNotMatch(body, /ブラウザ[^。\n]*(?:で取得して|からダウンロードして)ください/);
});

test("限界の明記: 安全は人の確認と sha256 の照合に依り、文書どおりに動くことは試験で保証できない。承認の回数の目安", () => {
  assert.match(
    rules,
    /安全は、「承認のときに、人が、画面のコマンドを確かめること」と「sha256 の照合」に依る/,
  );
  assert.match(rules, /文書どおりに動くことは、試験では保証できない/);
  assert.match(text, /約 12 回、コマンドの承認の確認が出ます/);
  assert.match(
    text,
    /auto モード（権限の自動判定）[^\n]*自動判定で止められたときは、出た文面をそのまま利用者に伝え/,
  );
  assert.match(text, /\*\*チャットでの「はい」[^\n]*auto モードでも必ず取る\*\*/);
});

test("症状表: 観察した症状のとおり（約 1 分後に終了）。原因が未確認のものは、未確認と書く。相談先は『この plugin を配布した COMCREATE』", () => {
  assert.match(body, /起動して約 1 分後に終了する/);
  assert.match(body, /`Killed: 9`、「開けません」 \| 原因は未確認/);
  assert.doesNotMatch(body, /管理者/);
  assert.match(body, /この plugin を配布した COMCREATE（連絡先: contact@comcreate-info\.com）/);
  assert.match(body, /目安として約 150MB/);
  assert.match(body, /利用者の Terminal から起動するときは未確認/);
  assert.doesNotMatch(body, /実機/);
});

test("取得した tar.gz は、利用者が自分で消してよい（消さなくても動く）。このコマンドは rm を実行しない", () => {
  assert.match(body, /利用者が、自分で消してよい/);
  assert.match(body, /消さなくても動く/);
});

test("手順 5（実行）: tar が失敗したとき（ファイルがない・gzip でない）は、OK が出ない（fail-open しない）", () => {
  const c = command(5, "tar -tzf");
  const gone = fixture("actual", GOOD);
  rmSync(join(gone.home, ".touryou", "work", "touryou-9.9.9-darwin-arm64.tar.gz"));
  const r1 = sh(c, gone.home, gone.P);
  assert.doesNotMatch(r1.stdout, /OK/);
  assert.notEqual(r1.status, 0);
  const bad = fixture("actual", GOOD);
  writeFileSync(
    join(bad.home, ".touryou", "work", "touryou-9.9.9-darwin-arm64.tar.gz"),
    "gzip ではない",
  );
  const r2 = sh(c, bad.home, bad.P);
  assert.doesNotMatch(r2.stdout, /OK/);
  assert.notEqual(r2.status, 0);
});

test("手順 4 と make-checksums.mjs の出力の結合: 実際の CLI が出した checksums.json を、手順 4 のコマンドで照合できる（形式が変わると、/setup が常に止まるのを、検出する）", () => {
  const x = fixture("actual", GOOD);
  const f = join(x.home, ".touryou", "work", "touryou-9.9.9-darwin-arm64.tar.gz");
  const hash = spawnSync("shasum", ["-a", "256", f], { encoding: "utf8" }).stdout.split(" ")[0];
  const dir = join(x.home, "dist");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "touryou-9.9.9-darwin-arm64.tar.gz.sha256"),
    `${hash}  touryou-9.9.9-darwin-arm64.tar.gz\n`,
  );
  // .mcpbの sha256 は別の値。手順 4 の grep -c が、tar.gz の 1 件だけを数えること
  writeFileSync(
    join(dir, "touryou-mcp-9.9.9.mcpb.sha256"),
    `${"d".repeat(64)}  touryou-mcp-9.9.9.mcpb\n`,
  );
  const out = join(x.P, "checksums.json");
  const gen = spawnSync(
    process.execPath,
    [join(root, "scripts", "make-checksums.mjs"), dir, "9.9.9", out],
    {
      encoding: "utf8",
    },
  );
  assert.equal(gen.status, 0, gen.stderr);
  const r = sh(command(4, 'grep -c -F "'), x.home, x.P);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^1\n/);
});

test("手順 7: ls -lR@ は、ディレクトリがなくても 0 になるので、直後の --help で、展開できていることを確かめる", () => {
  assert.match(step(7), /ディレクトリがなくても `grep -c` が `0` になる/);
  assert.match(step(7), /直後の `--help` が、使い方を出すこと/);
});

test("手順 8: 絶対パスは <H>/ で始まらなければ止まる。人が入力するパスは、バックスラッシュを含むときも止まる", () => {
  assert.match(step(8), /`<H>\/` で始まらなければ、止まる/);
  assert.match(text, /`;`・`\\` を含むときは、止まる/);
});

const CONTACT = "contact@comcreate-info.com";
const CONTACT_TEXT = `COMCREATE（連絡先: ${CONTACT}）`;

test("連絡先: プレースホルダーが残らない", () => {
  for (const f of [
    "plugin/commands/setup.md",
    "plugin/.claude-plugin/plugin.json",
    "docs/launchd.md",
  ]) {
    const text = readFileSync(join(root, f), "utf8");
    assert.doesNotMatch(text, /<担当者の連絡先>/, `${f}: プレースホルダーが残っている`);
  }
});

test("連絡先: 案内文（定型文 5 行・症状表 3 行）の、どれにも入っている", () => {
  const lines = readFileSync(join(root, "plugin/commands/setup.md"), "utf8").split("\n");
  const pick = (re) => {
    const found = lines.filter((l) => re.test(l));
    assert.equal(found.length, 1, `${re}: ちょうど 1 行にある`);
    return found[0];
  };
  const targets = [
    /^\s*定型文（`checksums\.json` がない/,
    /^\s*定型文（照合の失敗）/,
    /^\s*定型文（取得の失敗）/,
    /^\s*定型文（quarantine）/,
    /^\s*定型文: 「配布物の中身が、想定と違います/,
    /^\| `touryou-daemon --help` は通るが/,
    /^\| `Killed: 9`/,
    /^\| 手順 4 で、照合に失敗する/,
  ];
  for (const re of targets) assert.ok(pick(re).includes(CONTACT_TEXT), `${re}: 連絡先が入っている`);
  const all = lines.join("\n").split(CONTACT_TEXT).length - 1;
  assert.equal(all, targets.length, "連絡先の案内は、この 8 か所だけ");
});

test("連絡先: 追跡している md・json のメールアドレスは、許可の 1 件と、予約済みの試験用のドメインだけ", () => {
  const r = spawnSync("git", ["ls-files", "*.md", "*.json"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, "git ls-files が動く");
  const found = new Map();
  for (const f of r.stdout.split("\n").filter((x) => x !== "" && !x.endsWith("lock.json"))) {
    const text = readFileSync(join(root, f), "utf8");
    // 末尾が英字の TLD のものだけ（`name@10.28.0` のような、パッケージの版は、アドレスではない）
    for (const m of text.matchAll(
      /[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    )) {
      found.set(m[0].toLowerCase(), f);
    }
  }
  const reserved = /@([a-z0-9.-]+\.)?(example\.(com|org|net)|invalid)$/;
  const unexpected = [...found].filter(([a]) => a !== CONTACT && !reserved.test(a));
  assert.deepEqual(unexpected, [], "許可の 1 件・試験用のドメイン以外のアドレスがある");
  assert.ok(found.has(CONTACT));
});

test("手順 9: 常駐は、同意の定型文にはっきり「はい」のときだけ。touryou launchd の決まったサブコマンドだけを使い、launchctl を直接は実行しない", () => {
  const s = step(9);
  assert.match(
    rules,
    /常駐（launchd）の登録は、利用者が定型文の問いに、はっきり「はい」と答えたときだけ/,
  );
  assert.match(s, /はっきり「はい」のときだけ/);
  assert.match(
    rules,
    /`--yes` は、利用者が定型文の問いにチャットで「はい」と答えたあとにだけ付ける。承認ダイアログの許可だけでは付けない/,
  );
  assert.match(s, /それ以外（「いいえ」・あいまい・質問）は、登録せずに 9-B へ進む/);
  assert.ok(s.indexOf("**同意**") < s.indexOf("launchd apply --yes"), "apply の前に同意を取る");
  assert.match(s, /`"\$HOME\/\.touryou\/current\/bin\/touryou" launchd init`/);
  assert.match(s, /`"\$HOME\/\.touryou\/current\/bin\/touryou" launchd apply --yes`/);
  assert.doesNotMatch(s, /launchctl (?:bootstrap|bootout|kickstart|load)/);
});

test("手順 9: 子の認証は扱わない。setup-token・トークンのファイルの案内も、子用の touryou-mcp の常駐もない", () => {
  const s = step(9);
  assert.match(rules, /\*\*子の認証は扱わない\*\*/);
  assert.doesNotMatch(s, /setup-token/);
  assert.doesNotMatch(s, /oauth-token/);
  assert.doesNotMatch(s, /run-mcp\.sh/);
  assert.doesNotMatch(s, /--daemon-url/);
});

test("版を上げるとき: 常駐中なら、止める前に init で確かめ（0 でなければ止めない）、はっきり「はい」のあと stop、手順 7 の後に apply --yes", () => {
  const up = /## 版を上げるとき（常駐にしているとき）\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  assert.match(up, /launchd status/);
  const init = up.indexOf("launchd init`");
  const stop = up.indexOf("launchd stop`");
  assert.ok(init > 0 && init < stop, "stop の前に init");
  assert.match(up, /0 でなければ、止めずに終わる/);
  assert.match(
    up,
    /はっきり「はい」のときだけ\*\* `"\$HOME\/\.touryou\/current\/bin\/touryou" launchd stop`/,
  );
  assert.match(up, /それ以外（「いいえ」・あいまい・質問）は、何もせずに、版を上げずに終わる/);
  assert.match(
    up,
    /手順 7 の後に、`"\$HOME\/\.touryou\/current\/bin\/touryou" launchd apply --yes`/,
  );
  assert.match(up, /常駐の設定のまま（ログイン時に自動で動くまま）起動し直します/);
  assert.match(up, /途中で止まったとき/);
  assert.match(up, /前回と同じ引数で/);
  assert.doesNotMatch(up, /0\.1\.0-beta|公開より前の版/);
});

test("手順 2: checksums.json の知らないキー（extensions。.mcpb）は読まない、と書いてある。make-checksums の出力の assets の形は変わらない", async () => {
  assert.match(
    text,
    /`extensions` など。[^\n]*は、読まない・確かめない（知らないキーがあっても、止まらない）/,
  );
  const { buildChecksums } = await import("./make-checksums.mjs");
  const h = "e".repeat(64);
  const r = buildChecksums({
    version: "9.9.9",
    read: (n) => `${h}  ${n.replace(/\.sha256$/, "")}\n`,
  });
  assert.deepEqual(Object.keys(r), ["version", "assets", "extensions"]);
  assert.deepEqual(Object.keys(r.assets), ["darwin-arm64"]);
  assert.equal(r.assets["darwin-arm64"].name, "touryou-9.9.9-darwin-arm64.tar.gz");
});

test("手順 9: 9-A・9-B の最後は、自動でつながるのを待って /start。つながらないときだけ Reconnect（または起動し直す）", () => {
  const s = step(9);
  const a = s.slice(s.indexOf("**9-A."), s.indexOf("**9-B."));
  const b = s.slice(s.indexOf("**9-B."));
  for (const part of [a, b]) {
    assert.match(part, /`\/mcp` で `plugin:touryou:node` を選んで Reconnect する/);
    assert.match(part, /Claude Code を起動し直す/);
    assert.match(part, /\*\*つながるのを待つ\*\*: [^\n]*自動でつながる（Reconnect は要らない/);
    assert.ok(part.indexOf("自動でつながる") < part.indexOf("/touryou:start"), "待ってから /start");
  }
  assert.match(s, /定型文（つながるのを待つ。9-A・9-B のどちらでも）/);
  assert.doesNotMatch(s, /node は失敗したままになっている/);
});

test("start.md: /setup の直後は、Reconnect（または起動し直し）を案内する", () => {
  const start = readFileSync(new URL("../plugin/commands/start.md", import.meta.url), "utf8");
  assert.match(start, /`\/setup` を同じ会話で実行した直後なら/);
  assert.match(start, /自動でつながる/);
  assert.match(start, /Reconnect/);
});

test("版を上げるとき: 2 のあとに、古い版のまま動く stdio の touryou-mcp をつなぎ直す（Reconnect か起動し直し）", () => {
  const up = /## 版を上げるとき（常駐にしているとき）\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
  assert.match(up, /古い版のまま動き続ける/);
  assert.match(up, /`\/mcp` で `plugin:touryou:node` を選んで Reconnect する/);
  assert.ok(
    up.indexOf("launchd apply --yes") < up.indexOf("Reconnect"),
    "apply のあとに Reconnect",
  );
});
