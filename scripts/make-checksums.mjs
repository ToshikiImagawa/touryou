// 配布物の sha256 を、plugin に埋め込む `checksums.json` にする（release.yml から呼ぶ。依存なし）。
// 使い方: node scripts/make-checksums.mjs <配布物のディレクトリ> <版> <出力のファイル>
// 配布物のディレクトリには、`touryou-<版>-darwin-arm64.tar.gz.sha256`（`shasum -a 256` の出力）がある（対象は arm64 のみ。x64 は対象外）。
// あわせて、デスクトップアプリの拡張機能 `touryou-mcp-<版>.mcpb.sha256` も読む。
// 出力: { "version": "<版>", "assets": { "darwin-arm64": { "name": "...", "sha256": "..." } }, "extensions": { "mcpb": { "name": "...", "sha256": "..." } } }
// `assets` は /setup が読む（tar.gz だけ）。`.mcpb` は /setup の対象ではないので、別のキー `extensions` に置く。
// 取得先の URL は書かない（plugin の /setup が、Release のタグ（v<版>）から組み立てる）。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 対象は arm64 のみ。x64 の .sha256 が混ざっても、読まない（release.yml が、配布物のファイル数を検査して、余分なものを弾く）。
export const TARGETS = ["darwin-arm64"];

/** `.sha256` の中身（`<64 桁の 16 進>  <ファイル名>`）から、ファイル名と sha256 を取り出す。 */
export function parseSha256File(text) {
  const m = /^([0-9a-f]{64}) [ *]?([^\s/\\]+)\n?$/.exec(text);
  if (m === null) throw new Error("sha256 のファイルの形が正しくない");
  return { sha256: m[1], name: m[2] };
}

export function buildChecksums({ version, read }) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`版の形が正しくない: ${version}`);
  const assets = {};
  for (const target of TARGETS) {
    const name = `touryou-${version}-${target}.tar.gz`;
    const parsed = parseSha256File(read(`${name}.sha256`));
    if (parsed.name !== name)
      throw new Error(`${name}.sha256 の中のファイル名が違う: ${parsed.name}`);
    assets[target] = { name, sha256: parsed.sha256 };
  }
  const mcpbName = `touryou-mcp-${version}.mcpb`;
  const mcpb = parseSha256File(read(`${mcpbName}.sha256`));
  if (mcpb.name !== mcpbName)
    throw new Error(`${mcpbName}.sha256 の中のファイル名が違う: ${mcpb.name}`);
  return { version, assets, extensions: { mcpb: { name: mcpbName, sha256: mcpb.sha256 } } };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, version, out] = process.argv.slice(2);
  if (dir === undefined || version === undefined || out === undefined) {
    process.stderr.write(
      "使い方: node scripts/make-checksums.mjs <配布物のディレクトリ> <版> <出力のファイル>\n",
    );
    process.exit(2);
  }
  const json = buildChecksums({ version, read: (f) => readFileSync(join(dir, f), "utf8") });
  writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
}
