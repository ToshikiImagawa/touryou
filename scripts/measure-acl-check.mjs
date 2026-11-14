// ACL の確かめ（@touryou/core/fs の aclProblem）1 回にかかる時間を測る（macOS での確かめ用）。
// 実行前に `pnpm build` が要る。使い方: node scripts/measure-acl-check.mjs
// 一時ディレクトリに 0600 のファイルを作り、(1) fd なし（毎回 /bin/ls を起こす）・(2) fd つきの初回（ls を起こして覚える）・
// (3) fd つきの 2 回目から（覚えたものを使う）の時間を、それぞれ 20 回の中央値で出す。ファイルは最後に消す。
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { aclProblem, clearAclCache } = await import(join(root, "packages/core/dist/fs.js"));
const dir = mkdtempSync(join(tmpdir(), "touryou-acl-measure-"));
const file = join(dir, "secret");
writeFileSync(file, "x\n", { mode: 0o600 });
const N = 20;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (f) => {
  const t = process.hrtime.bigint();
  const r = f();
  return { ms: Number(process.hrtime.bigint() - t) / 1e6, r };
};
try {
  const noFd = [];
  const first = [];
  const cached = [];
  for (let i = 0; i < N; i++) {
    noFd.push(time(() => aclProblem(file)).ms);
    clearAclCache();
    const fd = openSync(file, "r");
    try {
      const a = time(() => aclProblem(file, { fd }));
      if (a.r !== undefined) throw new Error(`確かめが拒んだ: ${a.r}`);
      first.push(a.ms);
      cached.push(time(() => aclProblem(file, { fd })).ms);
    } finally {
      closeSync(fd);
    }
  }
  console.log(`platform=${process.platform} node=${process.version} 回数=${N}`);
  console.log(
    `fd なし（毎回 ls）       中央値 ${median(noFd).toFixed(2)} ms・最大 ${Math.max(...noFd).toFixed(2)} ms`,
  );
  console.log(
    `fd つき・初回（ls あり） 中央値 ${median(first).toFixed(2)} ms・最大 ${Math.max(...first).toFixed(2)} ms`,
  );
  console.log(
    `fd つき・2 回目から      中央値 ${median(cached).toFixed(3)} ms・最大 ${Math.max(...cached).toFixed(3)} ms`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
