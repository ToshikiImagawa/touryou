#!/usr/bin/env bash
# touryou hook の本体（hooks.json のシェルの 1 行を通さない）を、PATH に node がない環境で確かめる。
# dist-smoke.sh（macOS の配布物）と scripts/dist-smoke-hook.test.mjs（Linux の CI。ビルドした cli）の両方から使う。
# 使い方: bash scripts/dist-smoke-hook.sh <touryou の起動口の絶対パス>
# 期待（設計 6.4）:
# - TOURYOU_DAEMON_URL・TOURYOU_NODE_TOKEN がなく、daemon も分からない（紐付けの前・touryou と関係のないセッション）→ 何も出さずに 0。
#   「フックは働いていない」の一言は、hooks.json のシェルの 1 行が「touryou が未配置」のときに出すもので、本体は出さない（scripts/hooks-command.test.mjs が確かめる）。
# - URL とトークンがあり、daemon に届かない → 拒否（2）で、理由に「届かない」。トークンの値は出さない。
set -euo pipefail
bin="${1:?touryou の起動口の絶対パス}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
hook_in='{"hook_event_name":"PreToolUse","session_id":"s","tool_name":"Write","tool_input":{}}'
set +e
echo "$hook_in" | env -i PATH=/usr/bin:/bin HOME="$work" "$bin" hook >"$work/hook0.out" 2>"$work/hook0.err"; c0=$?
echo "$hook_in" | env -i PATH=/usr/bin:/bin HOME="$work" TOURYOU_DAEMON_URL=http://127.0.0.1:1 TOURYOU_NODE_TOKEN=smoke-token "$bin" hook 2>"$work/hook2.err"; c2=$?
set -e
[ "$c0" = 0 ] || { echo "環境変数がないのに、終了コードが 0 でない: $c0"; cat "$work/hook0.err"; exit 1; }
[ "$c2" = 2 ] || { echo "daemon に届かないのに、終了コードが 2 でない: $c2"; cat "$work/hook2.err"; exit 1; }
# 終了コードだけでなく、出力も確かめる（予期しない例外で 0・2 になった場合と、区別する）
[ ! -s "$work/hook0.err" ] && [ ! -s "$work/hook0.out" ] || { echo "環境変数なし・daemon なしで、何かを出している（期待は、何も出さない）"; cat "$work/hook0.out" "$work/hook0.err"; exit 1; }
grep -q '届かない' "$work/hook2.err" || { echo "届かない由来の拒否でない（予期しない失敗の疑い）"; cat "$work/hook2.err"; exit 1; }
if grep -q 'smoke-token' "$work/hook2.err"; then echo "トークンの値が標準エラーに出ている"; exit 1; fi
echo "touryou hook OK"
