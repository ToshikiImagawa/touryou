import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";

const TTY = { stdin: false, stdout: false };
const PKG_VERSION = (
  JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
    version: string;
  }
).version;

describe("touryou --version", () => {
  it("開発のビルド（TOURYOU_DIST_VERSION なし）は package.json の版に「開発ビルド」を付ける", async () => {
    const r = await runBin(["--version"], { env: {}, isTTY: TTY });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${PKG_VERSION}（開発ビルド）\n`);
    expect(r.stderr).toBe("");
  });

  it("-v も同じ", async () => {
    const r = await runBin(["-v"], { env: {}, isTTY: TTY });
    expect(r.stdout).toBe(`${PKG_VERSION}（開発ビルド）\n`);
  });

  it("TOURYOU_DIST_VERSION があれば、その配布物の版だけを出す（印を付けない）", async () => {
    const r = await runBin(["--version"], {
      env: { TOURYOU_DIST_VERSION: "0.1.0-beta.6" },
      isTTY: TTY,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("0.1.0-beta.6\n");
  });

  it("窓口・トークンがなくても動く（daemon を呼ばない）", async () => {
    const r = await runBin(["--version"], {
      env: {},
      isTTY: TTY,
      fetch: (() => {
        throw new Error("fetch を呼んではいけない");
      }) as typeof fetch,
    });
    expect(r.exitCode).toBe(0);
  });
});
