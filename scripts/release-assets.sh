#!/usr/bin/env bash

# Download a pinned release asset and verify it before any caller can unpack it.
# Mirrors are allowed only when they return the exact digest recorded in
# scripts/release-assets.json.
workloom_fetch_verified() { # <out> <asset-name> <url...>
  local out="$1"
  local asset_name="$2"
  local partial="${out}.part.$$"
  shift 2
  local url
  rm -f "$out" "$partial"
  if [ -n "${WORKLOOM_ASSET_CACHE:-}" ] && [ -f "$WORKLOOM_ASSET_CACHE/$asset_name" ]; then
    cp "$WORKLOOM_ASSET_CACHE/$asset_name" "$partial"
    if node scripts/release-assets.mjs verify "$partial" "$asset_name"; then
      mv -f "$partial" "$out"
      return 0
    fi
    rm -f "$partial"
    echo "❌ 本地缓存摘要不匹配：$asset_name"
    return 1
  fi
  for url in "$@"; do
    echo "  ↓ $url"
    if curl --http1.1 -fsSL \
      --retry 10 --retry-all-errors --retry-delay 4 \
      --connect-timeout 30 --max-time 1800 \
      -o "$partial" "$url"; then
      if node scripts/release-assets.mjs verify "$partial" "$asset_name"; then
        mv -f "$partial" "$out"
        return 0
      fi
      echo "  ⚠️  摘要不匹配，删除下载并回退下一源"
      rm -f "$partial"
    else
      echo "  ⚠️  下载失败，回退下一源"
      rm -f "$partial"
    fi
  done
  rm -f "$partial"
  echo "❌ 全部下载源失败或摘要不匹配：$asset_name"
  return 1
}
