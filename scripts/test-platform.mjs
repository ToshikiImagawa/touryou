// scripts/*.test.mjs が使う、OS で飛ばす理由。飛ばすのは Windows だけ（macOS・Linux では、いつもどおり走る）。

/**
 * macOS 向けの配布物（touryou-darwin-arm64）と、plugin のシェルのコマンド（hooks・.mcp.json の中継・install-runtime.sh・
 * /touryou:setup の手順）を、実際に sh・bash で走らせる試験を飛ばす理由。Windows ネイティブでは、これらは使われない
 * （Windows の配布と常駐は未決。T32-win-svc）。Windows では false でなく、理由の文字列になる。
 */
export const POSIX_ONLY =
  process.platform === "win32" &&
  "macOS 向けの配布物と plugin のシェルのコマンドの試験。Windows ネイティブでは使われない（Windows の配布は未決: T32-win-svc）";
