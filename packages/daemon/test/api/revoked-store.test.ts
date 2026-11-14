import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { FileRevokedStore, MemoryRevokedStore } from "../../src/api/revoked-store.js";

const HUMAN = "h".repeat(40);
const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "touryou-rev-"));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("FileRevokedStore（失効の印の永続化）", () => {
  it("足した印は読み戻せる。ファイルは 0600", () => {
    const dir = tmp();
    const path = join(dir, "revoked-tokens.json");
    const now = 1000;
    const s = new FileRevokedStore(path, { nowMs: () => now });
    s.add(HASH_A, 5000);
    expect((statSync(path).mode & 0o777).toString(8)).toBe("600");
    // 別のインスタンス（起動し直しに相当）でも読める。
    const s2 = new FileRevokedStore(path, { nowMs: () => now });
    expect(s2.load().get(HASH_A)).toBe(5000);
  });

  it("期限を過ぎた印は、読み込み・書き込みのときに落とす", () => {
    const dir = tmp();
    const path = join(dir, "revoked-tokens.json");
    let now = 1000;
    const s = new FileRevokedStore(path, { nowMs: () => now });
    s.add(HASH_A, 2000);
    s.add(HASH_B, 9000);
    now = 3000; // HASH_A は期限切れ
    const loaded = new FileRevokedStore(path, { nowMs: () => now }).load();
    expect(loaded.has(HASH_A)).toBe(false);
    expect(loaded.get(HASH_B)).toBe(9000);
  });

  it("壊れた形は、警告を 1 回出して空で始める（印は消しても安全側）", () => {
    const dir = tmp();
    const path = join(dir, "revoked-tokens.json");
    const s = new FileRevokedStore(path);
    s.add(HASH_A, Date.now() + 1_000_000);
    rmSync(path);
    writeFileSync(path, "{ not json", { mode: 0o600 });
    const warned: string[] = [];
    const broken = new FileRevokedStore(path, { onCorrupt: (c) => warned.push(c) });
    expect(broken.load().size).toBe(0);
    expect(warned).toHaveLength(1);
    // 次の書き込みで、正しい形に書き直す。
    broken.add(HASH_B, Date.now() + 1_000_000);
    expect(new FileRevokedStore(path).load().has(HASH_B)).toBe(true);
  });
});

describe("credential store の失効の印（起動し直しでも expired）", () => {
  it("保存先があれば、起動し直しのあとも wasExpired が true", () => {
    const store = new MemoryRevokedStore();
    const now = 1000;
    const a = createCredentialStore({
      humanToken: HUMAN,
      revokedStore: store,
      nowMs: () => now,
      clock: () => new Date(now).toISOString(),
    });
    const token = a.issueNodeToken("n1", "child");
    a.expireNode?.("n1");
    expect(a.wasExpired?.(token)).toBe(true);
    // 起動し直し: 新しい store を、同じ保存先から作る。
    const b = createCredentialStore({
      humanToken: HUMAN,
      revokedStore: store,
      nowMs: () => now,
      clock: () => new Date(now).toISOString(),
    });
    expect(b.wasExpired?.(token)).toBe(true);
  });

  it("最長の期限を過ぎたら、wasExpired は false に戻る", () => {
    const store = new MemoryRevokedStore();
    let now = 1000;
    const a = createCredentialStore({
      humanToken: HUMAN,
      revokedStore: store,
      nowMs: () => now,
      clock: () => new Date(now).toISOString(),
      expiry: { sdkIdleMs: 100, sdkAbsoluteMs: 1000, bindAbsoluteMs: 1000, bindIdleMs: 100 },
    });
    const token = a.issueNodeToken("n1", "child");
    a.expireNode?.("n1");
    expect(a.wasExpired?.(token)).toBe(true);
    now += 2000; // 最長の期限（sdkAbsoluteMs=1000）を超える
    expect(a.wasExpired?.(token)).toBe(false);
  });
});
