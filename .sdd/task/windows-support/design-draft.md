---
id: "design-windows-scope"
title: "範囲の強制（フックの判定）を Windows の形のパスに対応させる"
type: "design"
status: "draft"
sdd-phase: "plan"
sdd-version: "5.1.0"
impl-status: "not-implemented"
created: "2026-11-19"
updated: "2026-11-19"
depends-on: ["spec-touryou", "design-touryou"]
tags: ["windows", "scope", "hook-policy", "security"]
category: "portability"
---

# 範囲の強制（フックの判定）を Windows の形のパスに対応させる

Windows 対応（T32-win-hook-policy）の技術設計の下書きです。これは一時的な文書で、実装が終わったら、大事な決めを [touryou.md](../../adr/touryou.md) に移して消します。
要求は [touryou.md](../../requirement/touryou.md) の FR_014・NFR_016 です。タスクの行は [tasks.md](../initial-spec-design/tasks.md) の T32-win-* にあります。

## 1. 目的と範囲

- **目的**: daemon のフックの判定（`packages/daemon/src/sdk/hook-policy.ts`・`path-resolve.ts`）が、Windows の形のパスでも macOS と同じ強さで範囲を強制すること。判定できないときは拒否します（NFR_016）。
- **範囲に入るもの**
  - 書き込みの道具（Write・Edit など）の行き先
  - Bash の語と、`cd`・`pushd` の行き先
  - 禁じる場所の読み取りの判定（`checkProtected`）
  - 拡張の判定（`grantedOnlyByExtension`）
  - 実パス化（`resolveForWrite`・`withRealWritePath`）
- **範囲に入らないもの**
  - 常駐（T32-win-svc）
  - 配布物と導入
  - 秘密のファイルの ACL（core/fs.ts。持ち主の検査だけは 7 節で扱います）

## 2. いまの作り（macOS 前提の所）

| 所 | 前提 | Windows で起きること |
|:--|:--|:--|
| `path-resolve.ts` の `resolveForWrite` | `startsWith("/")` で絶対パスかどうかを決め、`split("/")` で分け、根を `/` として組み立て直す | `C:\a` は「絶対パスでない」として例外になる（拒否側に倒れるが、書き込みがすべて止まる） |
| `hook-policy.ts:796`、`:1074` ほか約 15 か所 | `startsWith("/")` でなければ cwd に `/` でつなぐ | `C:\a` が `C:\work/C:\a` になる。ドライブ相対や `\foo` の扱いも決まっていない |
| `protectedKind`（:154） | 祖先かどうかを `startsWith(real + "/")` で比べる。根は `/` | 区切りが `\` だと当たらない。結果として禁じる場所を見落とす（**許可側に倒れる**） |
| `lexical`・`cdDest`・`cdOutside` | `/` 区切りで `..` を畳み、`./`・`../` を見る | `cd ..\..`、`cd D:\`、`cd /d/x` が見えない |
| `safePositional`（:1036） | `:` を許し、`/` で始まるものと `..` を拒む | `C:foo`・`C:\x`・`..\x` が安全な引数として通る（**許可側に倒れる**） |
| `fold` | NFC にしてから小文字にする | Windows でも妥当。ただし、別名の形（8.3、末尾の `.`、ADS）は fold では同じものにならない |
| `:885-886` | 生のパスを `evaluateScope` に渡す | core の側で塞いだ（ドライブ相対は invalidPath）。ただし、ここで正しく扱えるわけではない |

まとめると、拒否側に倒れる所と許可側に倒れる所が混ざっています。許可側に倒れるのは、文字列の `/` だけを区切りとみなしているためです。

## 3. 方針

### 3.1. パスの扱いを core の 1 つの部品に集める

daemon で `startsWith("/")`・`split("/")`・文字列の連結を使うのをやめます。かわりに、core に次の関数をそろえ（`scope.ts` で始めたものを独立させる）、すべてこれを通します。

| 関数 | 役目 |
|:--|:--|
| `parsePath(raw, style)` | 生のパスを `{ kind: "abs", root, segments } \| { kind: "rel", segments } \| { kind: "invalid", reason }` に分ける |
| `joinPath(base, rel)` | 根より上には `..` で行かない |
| `toCanonical(p)` | 比べる用の内部の形（`/C:/a/b`、`/UNC/srv/share/a`）。`fold` を通す |
| `toNative(p)` | fs の API に渡す形（`C:\a\b`） |
| `isUnderPath(child, dir)` | 区切りと根を正しく扱う |

`style` は `"posix" | "win"` です。`process.platform` から直接読まず、引数で渡します（3.5 節）。

### 3.2. 生のパスの形と扱い（style = win）

| 形 | 例 | 扱い |
|:--|:--|:--|
| ドライブの絶対パス | `C:\a`、`C:/a` | 絶対パス |
| UNC | `\\srv\share\a` | 絶対パス（根は `srv\share`） |
| 相対 | `a\b`、`a/b`、`..\x` | cwd につなぐ |
| ドライブ相対 | `C:foo` | **invalidPath**（core で済み） |
| 区切り 1 つで始まる | `\foo`、`/foo` | **invalidPath**（どのドライブか決まらない。core で済み）。Bash の語は 3.3 節を参照 |
| `\\?\`、`\\.\` | `\\?\C:\a` | `\\?\C:\` と `\\?\UNC\` は読み替える。`\\.\`（デバイス）は invalidPath |
| 別名の形 | 要素の末尾の `.` や空白、`~1` を含む 8.3 の名前、`:` による ADS | **invalidPath**。いまは書き込みだけで拒んでいるが、読み取りの判定でも拒むようにする（3.4 節） |
| 予約デバイス名 | `NUL`、`CON`、`COM1`、`LPT1`、`AUX`、`PRN`（拡張子付きを含む） | **invalidPath**（新しく足す） |
| `~` | `~\x` | いまの POSIX と同じ扱い（展開しない語は判定できないので拒否） |

### 3.3. Bash の語（Windows の Claude Code は Git Bash で命令を動かす）

- 判定の対象は、bash が引用符を外した**あとの語**（`commandWords` の結果）です。引用符のない `C:\foo` は、bash の上では `C:foo` になります。この形はドライブ相対として拒否します。引用符付きの `"C:\foo"` は絶対パスとして扱います。
- MSYS の形 `/c/Users/x` は、ドライブ `c` の絶対パス（`C:\Users\x`）に読み替えます。
- それ以外の `/` で始まる語（`/tmp`、`/usr/bin`、`/dev/null`）は、Git の導入先から見た場所を指します。ただし、どこを指すかは確かめられません。
  - `/dev/null` だけは無害として許します。
  - ほかの語が禁じる場所の判定に関わるとき（書き込み・消す・動かすコマンドの引数のとき）は、**拒否**します。
  - 読み取りだけのコマンドの語は、いまの「パスに見える語だけを見る歯止め」と同じ扱いにします。
- `cd`・`pushd` は、次のどれかなら **outsideWorktree** です。
  - 別のドライブへ移る（`cd D:/x`、`cd /d/x`）
  - UNC へ移る
  - 根より上に出る
- `safePositional` には、次の条件を足します。
  - `^[A-Za-z]:` で始まらない
  - `\` を含まない
  - `..` を `/` と `\` の両方で分けて見る

### 3.4. 禁じる場所の判定（読み取りの側）

- `protectedKind` の祖先の判定は、`isUnderPath(toCanonical(...))` に置き換えます。根は `/C:/`、`/UNC/srv/share/` です。
- `checkProtectedPath` は、Windows の形のとき、3.2 節の別名の形と予約デバイス名を**読み取りでも拒否**します。8.3 の名前や ADS で、禁じる場所（`.claude/` や引き出し）を別の名前で読めてしまうためです。
- `realpath` は、Windows ではジャンクションとシンボリックリンクを解きます。8.3 の名前は、Node の `realpath` では長い名前に戻らないことがあります。そのため、8.3 の名前は実パス化に頼らず、文字の形で拒否します。
- 文字の形の検査に加えて、すでにある禁じる場所は、**ファイルの ID（`stat` の `dev` と `ino`。NTFS ではボリュームの番号とファイルの番号）**でも照らします。daemon は、起動のときと範囲が変わったときに、禁じる場所の ID を覚えておきます。そして、判定するパスの最も深い既存の祖先の ID を、覚えておいた ID と比べます。
  - こうすると、文字の形で見落とした別名（大文字と小文字、8.3、ハードリンクでないリンク）も、同じものとして当たります。
  - 2 つの検査のどちらかで当たれば拒否します。
  - ID を取れないときも拒否します。

### 3.5. 実パス化（`resolveForWrite`）

- `parsePath` で根と要素に分けます。根（`C:\`、`\\srv\share\`）は pop しません。
- 最も深い既存の祖先を `realpath` にして、残りの要素をつなぎます。根まで戻っても解けなければ拒否します（いまの作りのとおり）。
- 先の無いリンクの検査（`lstat`）は、ジャンクションにもそのまま当てます。

### 3.6. style の決め方とテスト

- daemon が起動するときに `process.platform` から style を 1 度だけ決め、`decideToolUse` などに引数で渡します。
- こうしておくと、テストでは style を明示できます。macOS と Linux の CI でも、Windows の判定（文字の形の扱い）を動かせます。fs の部分は `FsOps` で差し替えます。
- Windows の runner では、実物の NTFS（ジャンクション、8.3、ADS）を使うテストを別に足します。8.3 の名前が作られないボリュームもあるので、作れないときはテストを飛ばします（理由をログに出す）。

## 4. 進め方（タスクの分け方）

ひとつの変更にまとめると見きれないので、次の順に PR を分けます。どれも、拒否側に倒れる変更から先に入れます。

| 段 | 中身 | 主なファイル |
|:--|:--|:--|
| W1 | core にパスの部品をまとめ、予約デバイス名を足す（3.1・3.2 節） | `core/src/path.ts`（新しく作る）、`scope.ts` |
| W2 | `resolveForWrite`・`withRealWritePath`・`resolveScope` を部品に置き換え、style を引数にする（3.5・3.6 節） | `path-resolve.ts`、`hook-policy.ts` |
| W3 | 書き込みの道具と拡張の判定（`:796`、`:885`、`safePositional`） | `hook-policy.ts` |
| W4 | 禁じる場所の判定（`protectedKind`、`checkProtectedPath`、`isDrawer`）と、別名の形を読み取りでも拒むこと（3.4 節） | `hook-policy.ts` |
| W5 | Bash の語と `cd`・`pushd`（3.3 節） | `hook-policy.ts`、`read-only-search.ts` |
| W6 | Windows の runner で、実物の NTFS を使うテスト | `daemon/test/sdk/*` |

W1 と W2 が済むまでは、W3〜W5 は始めません。それぞれの段で、POSIX の style のテストが変わらないことを確かめます（macOS の動きを変えない）。

## 5. 守ること

- 判定できない形はすべて拒否します。許可側に倒す例外は、`/dev/null` と、リダイレクトの行き先の `NUL` だけです。
- macOS（style = posix）の判定の結果は変えません。いまのテストを、すべてそのまま通します。
- 拒否の理由は、いまの `ScopeViolationReason`（`invalidPath`・`outsideWorktree` など）の中から選び、新しい理由は足しません。状態画面と文言への影響を避けるためです。

## 6. 考えた別の案

| 案 | 採らない理由 |
|:--|:--|
| 入口で `\` を `/` に置き換えるだけにする | ドライブ相対、UNC、別名の形、MSYS の形を区別できない。いま見つかっている穴（`C:foo`）を、そのまま持ち込む |
| `path.win32` を直接使う | `normalize` が根より上の `..` を黙って捨て、別名の形も通す。比べる用の形（大文字と小文字、NFC）も持たない。部品の中で、分けるところにだけ使うのはよい |
| Windows ではフックの判定を止め、Claude Code の権限の設定だけに任せる | FR_014 の強制がなくなる。NFR_016 の「同じ強さの検査」に反する |

## 7. 決めたこと

1. **秘密のファイルは、作るときに守り、読むときに確かめる。**
   - **作るとき**: TouRyou が作る秘密のファイルとディレクトリは、継承を切った明示の DACL にします。許すのは自分と SYSTEM だけで、`icacls /inheritance:r /grant:r` に当たる設定です。これで「既定の継承で他人が読める」を、もとから起こさないようにします。
   - **読むとき**: いまの ACL の検査に、持ち主の検査を足します。持ち主は PowerShell の `Get-Acl` で取ります。
     - `Get-Acl` の起動は重い（数百 ms）ので、結果を「パス、ファイルの ID、更新時刻」で覚えておきます。どれかが変わったときだけ、取り直します。
     - 取れないときは拒否します。
   - **許す持ち主**: 自分、SYSTEM、Administrators です。
     - Administrators を許すのは、自分がそのグループに属しているときだけです。昇格した処理が作ったファイルは、持ち主が Administrators になるためです。
     - 属していないなら、Administrators が持ち主のファイルは拒否します。管理者は、もともと何でもできる相手なので、属している場合に許しても守りは弱くなりません。
   - **採らない案**: ネイティブの補助（N-API など）は、配布物と署名の手間が増えるので採りません。`Get-Acl` が遅すぎると測れたときに、改めて考えます。
2. **MSYS の場所（`/tmp`、`/usr` など）は拒否する。** `cygpath` で読み替えると、Git の導入のしかたに判定が左右されます。必要だと分かったら、あとで足します。
3. **予約デバイス名**は、ファイルのパスとしてはすべて拒否します。例外は、Bash のリダイレクトの行き先の `NUL` と `/dev/null` だけで、どちらも無害なので許します（POSIX の `/dev/null` と同じ扱い）。

## 8. 未解決の事項

1. **Desktop の子**。Windows の Claude Desktop で、子にフックが継承されるかどうか。IR_002 の項目 4 と同じく、手で確かめるのを待ちます。
2. **ファイルの ID**（3.4 節）が、ReFS やネットワークのドライブ（UNC）でも重ならずに取れるかどうか。W6 で確かめます。取れない場所は拒否側に倒します。
