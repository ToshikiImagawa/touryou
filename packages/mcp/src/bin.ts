#!/usr/bin/env node
/**
 * `touryou-mcp` の入口。統合セッション用の `--stdio`だけを持つ。
 *
 * 子用の HTTP の待ち受け（従来の引数なしの起動。launchd の 2 つ目の常駐）と、SDK の子用の中継（`--child-stdio`）は外した
 * （常駐は daemon だけ）。それらの起動は、理由と次の操作を出して終了コード 2。
 */

const fatal = (what: string, e: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), event: what, error: String(e instanceof Error ? (e.stack ?? e.message) : e) })}\n`,
  );
  process.exit(1);
};
process.on("uncaughtException", (e) => fatal("uncaughtException", e));
process.on("unhandledRejection", (e) => fatal("unhandledRejection", e));

const argv = process.argv.slice(2);
if (argv[0] === "--version" || argv[0] === "-v") {
  // `touryou-mcp --version`（配布物の版。serverInfo.version と同じ版。daemon との食い違いの切り分け）。
  const { resolveVersion, versionLine } = await import("@touryou/core");
  const { createRequire } = await import("node:module");
  const pkgVersion = (() => {
    try {
      const v = (createRequire(import.meta.url)("../package.json") as { version?: unknown })
        .version;
      return typeof v === "string" ? v : "0.0.0";
    } catch {
      return "0.0.0";
    }
  })();
  process.stdout.write(
    `${versionLine(resolveVersion({ packageVersion: pkgVersion, env: process.env }))}\n`,
  );
  process.exit(0);
}
if (argv[0] === "--stdio") {
  // 標準出力は MCP の通信に使うので、ここでは何も書かない。
  // process.exit() は使わない（macOS のパイプで、書き残しの標準出力が切れうる）。標準出力を書き終えてから終わる。
  const { runStdio } = await import("./stdio.js");
  const code = await runStdio(argv.slice(1), process.env, {
    stderr: (t) => process.stderr.write(t),
  });
  process.exitCode = code;
  process.stdout.write("", () => process.exit(code));
} else {
  process.stderr.write(
    "失敗 [removed]: touryou-mcp の HTTP の待ち受け（子用の常駐）と --child-stdio は外した。常駐は daemon だけ\n次の操作:\n  - 統合セッションからは touryou-mcp --stdio で使う（plugin の .mcp.json）\n  - 前の版の常駐が残っていれば touryou launchd uninstall --yes で外し、touryou launchd init・touryou launchd apply --yes で入れ直す\n",
  );
  process.exitCode = 2;
}
