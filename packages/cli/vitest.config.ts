import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// テストは core のソースを直接参照する（core を先にビルドしなくても `pnpm test` が動く）。
// 本番の解決（dist）は scripts/check-core-resolution.mjs で確かめる。
export default defineConfig({
  // launchd.test.ts は process.umask() を使う（worker threads では例外になる）ので、forks に固定する
  test: { pool: "forks" },
  resolve: {
    alias: [
      {
        find: /^@touryou\/core\/fs$/,
        replacement: fileURLToPath(new URL("../core/src/fs.ts", import.meta.url)),
      },
      {
        find: /^@touryou\/core$/,
        replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      },
    ],
  },
});
