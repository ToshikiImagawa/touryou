import { describe, expect, it } from "vitest";
import { checkPluginDir, type PluginDirPorts } from "../../src/sdk/plugin-dir.js";

const GOOD = '{"name":"touryou","version":"1"}';
const ports = (
  files: Record<string, string>,
  links: Record<string, string> = {},
  forbiddenRoots: string[] = ["/repo", "/trees", "/state", "/home/u/.touryou"],
): PluginDirPorts => ({
  readFile: (p) => {
    const v = files[p];
    if (v === undefined) throw new Error("ENOENT");
    return v;
  },
  realpath: (p) => {
    const n = p.replace(/\/+$/, "");
    if (n === "/gone") throw new Error("ENOENT");
    return links[n] ?? n;
  },
  forbiddenRoots,
});

describe("子に付ける plugin の場所の確かめ", () => {
  it("絶対パスで、plugin.json の name が一致すれば通る。文には実パスを入れる", () => {
    const p = ports(
      { "/real/p/.claude-plugin/plugin.json": GOOD },
      { "/link/p": "/real/p", "/real/p": "/real/p" },
    );
    expect(checkPluginDir("/link/p", p)).toEqual({ ok: true, dir: "/real/p" });
    expect(checkPluginDir("/real/p/", p)).toEqual({ ok: true, dir: "/real/p" });
  });

  it("リンクの先が作業ツリー・リポジトリ・状態・touryou の置き場の中なら断る", () => {
    const files = {
      "/trees/a/fake/.claude-plugin/plugin.json": GOOD,
      "/repo/fake/.claude-plugin/plugin.json": GOOD,
      "/state/x/.claude-plugin/plugin.json": GOOD,
      "/home/u/.touryou/p/.claude-plugin/plugin.json": GOOD,
    };
    const p = ports(files, { "/ok/link": "/trees/a/fake" });
    for (const d of ["/ok/link", "/repo/fake", "/state/x", "/home/u/.touryou/p", "/trees"]) {
      const r = checkPluginDir(d, p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("の中にある");
    }
  });

  it.each([
    ["rel/p", "絶対パスでない"],
    ["/a/../p", ".. の区切り"],
    ["/a/it's", "安全に書けない"],
    ["/a/x\ny", "安全に書けない"],
    ["/a/x\u0007", "安全に書けない"],
    [`/a/x${String.fromCharCode(0x2028)}`, "安全に書けない"],
    ["/gone", "実パスにできない"],
    ["/none", "読めない"],
    ["/bad", "JSON でない"],
    ["/other", "名前が"],
  ])("通らない: %j", (dir, reason) => {
    const r = checkPluginDir(
      dir,
      ports({
        "/bad/.claude-plugin/plugin.json": "{",
        "/other/.claude-plugin/plugin.json": '{"name":"x"}',
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain(reason);
      expect(r.reason).not.toContain(dir); // 値・パスは理由に入れない
    }
  });

  it("darwin・win32 の想定（foldCase）では、大文字小文字の違う綴りも同じ場所と見なして断る", () => {
    const files = { "/Users/u/Repo/fake/.claude-plugin/plugin.json": GOOD };
    const p = { ...ports(files, {}, ["/users/u/repo"]), foldCase: true };
    expect(checkPluginDir("/Users/u/Repo/fake", p).ok).toBe(false);
    const linux = ports(files, {}, ["/users/u/repo"]);
    expect(checkPluginDir("/Users/u/Repo/fake", linux).ok).toBe(true);
  });

  it("断る根は確かめのたびに realpath にし直す（起動のあとにできた根やリンクの根）", () => {
    const files = { "/real/trees/a/.claude-plugin/plugin.json": GOOD };
    let made = false;
    const p: PluginDirPorts = {
      ...ports(files),
      realpath: (x) => {
        if (x === "/trees-link") {
          if (!made) throw new Error("ENOENT");
          return "/real/trees";
        }
        return x;
      },
      forbiddenRoots: ["/trees-link"],
    };
    expect(checkPluginDir("/real/trees/a", p).ok).toBe(true);
    made = true;
    expect(checkPluginDir("/real/trees/a", p).ok).toBe(false);
  });

  it("実パスに安全に書けない文字があれば断る", () => {
    const r = checkPluginDir("/l", ports({}, { "/l": "/it's" }));
    expect(r.ok).toBe(false);
  });
});

describe("pluginDirPortsOf（compose）", () => {
  it("断る根に repoRoot・worktreeRoot・stateDir・<H>/.touryou を入れ、darwin・win32 で大文字小文字をそろえる", async () => {
    const { pluginDirPortsOf } = await import("../../src/compose.js");
    const c = { repoRoot: "/r", worktreeRoot: "/t", stateDir: "/s" };
    const mac = pluginDirPortsOf(c, "darwin", "/h");
    expect(mac.forbiddenRoots).toEqual(["/r", "/t", "/s", "/h/.touryou"]);
    expect(mac.foldCase).toBe(true);
    expect(pluginDirPortsOf(c, "win32", "/h").foldCase).toBe(true);
    expect(pluginDirPortsOf(c, "linux", "/h").foldCase).toBe(false);
  });
});
