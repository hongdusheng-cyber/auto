#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  local candidates=(
    "/Users/macos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

NODE_BIN="$(find_node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "没有找到 Node.js。"
  echo "请先安装 Node.js，或在 Codex 桌面环境里运行本文件。"
  echo
  read -k 1 "?按任意键关闭..."
  exit 1
fi

echo "使用 Node：$NODE_BIN"
echo "启动本地控制台..."
"$NODE_BIN" scripts/control-panel.mjs
