/**
 * touryou-mcp の版（MCP の serverInfo.version）。daemon との版の食い違いの切り分けに使う。
 * 版の決め方は core の `resolveVersion` と同じ（define `__TOURYOU_VERSION__` → 環境変数 `TOURYOU_DIST_VERSION` → 隣の package.json）。
 * - 拡張機能（.mcpb）: `scripts/mcpb-build.sh` が esbuild の `--define` で `__TOURYOU_VERSION__` に版を埋める。
 * - tar.gz: `scripts/dist-build.sh` の起動スクリプトが `TOURYOU_DIST_VERSION` を設定する。
 * - 手元のビルド: `dist/` の隣の `package.json` を読む。どれもなければ `0.0.0`。
 */
import { createRequire } from "node:module";
import { resolveVersion } from "@touryou/core";

export function touryouVersion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  let packageVersion = "0.0.0";
  try {
    const v = (createRequire(import.meta.url)("../package.json") as { version?: unknown }).version;
    if (typeof v === "string") packageVersion = v;
  } catch {
    // 隣に package.json がなければ 0.0.0（下の resolveVersion が define・環境変数を先に見る）。
  }
  return resolveVersion({ packageVersion, env }).version;
}
