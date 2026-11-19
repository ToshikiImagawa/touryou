// scripts/*.test.mjs が使う、OS で飛ばす理由。飛ばすのは Windows だけ（macOS・Linux では、いつもどおり走る）。

/**
 * 配布物とインストール（touryou-darwin-arm64・install-runtime.sh・/touryou:setup と Desktop の導入の手順）を、実際に走らせる試験を飛ばす理由。
 * Windows の配布物はまだない（NFR_016 の後の段階）。plugin のフック・.mcp.json の起動は、Windows の子のセッションでも走るので、ここで飛ばさない。
 * Windows では false でなく、理由の文字列になる。
 */
export const DIST_ONLY =
  process.platform === "win32" &&
  "配布物とインストールの試験。Windows の配布物ができるまで飛ばす（NFR_016）";
