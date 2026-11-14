#!/usr/bin/env bash
# Claude デスクトップアプリの拡張機能（.mcpb）を作る。使い方: bash scripts/mcpb-build.sh <出力のディレクトリ（絶対パス）>
# - 前提: pnpm install --frozen-lockfile と pnpm build が済んでいる（packages/mcp/dist/mcpb-entry.js がある）。
# - 中身は touryou-mcp の JS だけ（daemon・Node は入れない。Node はデスクトップアプリの内蔵のものを使う）。
#   esbuild で MCP SDK・zod・@touryou/core を 1 ファイルの ESM（target node22・ネイティブなし）にまとめる。
# - manifest の version は DIST_VERSION（なければ package.json の version）。
# - esbuild と公式の @anthropic-ai/mcpb は、ルートの devDependencies（版を固定・pnpm-lock.yaml）のものを使う
#   （`pnpm install --frozen-lockfile` のもの。lockfile の外からは取らない）。署名はしない。
# - 出力: touryou-mcp-<版>.mcpb と touryou-mcp-<版>.mcpb.sha256（`shasum -a 256` の形）。
set -euo pipefail
out="${1:?出力のディレクトリ（絶対パス）を渡す}"
root="$(cd "$(dirname "$0")/.." && pwd)"
version="${DIST_VERSION:-$(node -e 'process.stdout.write(require(process.argv[1]).version)' "${root}/package.json")}"
[[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "版の形が正しくない: ${version}" >&2; exit 1; }
case "${version}" in *..*) echo "版の形が正しくない: ${version}" >&2; exit 1 ;; esac
entry="${root}/packages/mcp/dist/mcpb-entry.js"
[ -f "${entry}" ] || { echo "${entry} がない（pnpm build を先に）" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "${work}/pkg/server" "${out}"
(cd "${root}" && pnpm exec esbuild "${entry}" \
  --bundle --platform=node --format=esm --target=node22 \
  --define:__TOURYOU_VERSION__="\"${version}\"" \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="${work}/pkg/server/index.mjs" --log-level=warning)
if grep -q '\.node"' "${work}/pkg/server/index.mjs"; then
  echo "ネイティブのモジュール（.node）の読み込みが含まれている" >&2
  exit 1
fi
sed "s/@VERSION@/${version}/" "${root}/packages/mcp/mcpb/manifest.template.json" > "${work}/pkg/manifest.json"
(cd "${root}" && pnpm exec mcpb validate "${work}/pkg/manifest.json")
name="touryou-mcp-${version}.mcpb"
(cd "${root}" && pnpm exec mcpb pack "${work}/pkg" "${out}/${name}")
(cd "${out}" && shasum -a 256 "${name}" > "${name}.sha256")
cat "${out}/${name}.sha256"
