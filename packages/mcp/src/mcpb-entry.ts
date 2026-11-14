/**
 * Claude デスクトップアプリの拡張機能（`.mcpb`）の入口。`scripts/mcpb-build.sh` が、esbuild で 1 ファイルにまとめる。
 * 動きは `touryou-mcp --stdio`（`bin.ts`）と同じ（`runStdio` を呼ぶ）。違いは、起動時に、内蔵の Node の版を標準エラーに 1 行出すことだけ
 * （デスクトップアプリが持つ Node の版は、公式の文書に記載がないため）。
 * 標準出力は MCP の通信に使うので、ここでは何も書かない。トークンは、引数・ログに出さない（`runStdio` が読む）。
 */
import { runStdio } from "./stdio.js";

process.stderr.write(
  `${JSON.stringify({ event: "mcpbStart", at: new Date().toISOString(), node: process.versions.node, platform: process.platform, arch: process.arch })}\n`,
);
const fatal = (what: string, e: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({ event: what, error: String(e instanceof Error ? e.message : e) })}\n`,
  );
  process.exit(1);
};
process.on("uncaughtException", (e) => fatal("uncaughtException", e));
process.on("unhandledRejection", (e) => fatal("unhandledRejection", e));

const argv = process.argv.slice(2);
const code = await runStdio(argv[0] === "--stdio" ? argv.slice(1) : argv, process.env, {
  stderr: (t) => process.stderr.write(t),
});
process.exitCode = code;
process.stdout.write("", () => process.exit(code));
