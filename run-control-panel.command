#!/bin/zsh
set -e

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"

PORT="${PORT:-17321}"
CONTROL_PANEL_HOST="${CONTROL_PANEL_HOST:-127.0.0.1}"
URL="http://localhost:${PORT}"

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

open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$URL" >/dev/null 2>&1 || true
  fi
}

NODE_BIN="$(find_node || true)"

echo "办公自动化控制台"
echo "项目目录：$PROJECT_DIR"
echo

if [[ -z "$NODE_BIN" ]]; then
  echo "没有找到 Node.js。"
  echo "请先安装 Node.js，或在 Codex 桌面环境里运行本文件。"
  echo
  read -k 1 "?按任意键关闭..."
  exit 1
fi

if curl -fsS "$URL" >/dev/null 2>&1; then
  echo "控制台已经在运行：$URL"
  echo "正在打开浏览器..."
  open_url
  exit 0
fi

echo "使用 Node：$NODE_BIN"
echo "启动本地控制台：$URL"
echo "关闭此窗口或按 Ctrl+C 可停止控制台。"
echo

export PORT
export CONTROL_PANEL_HOST
"$NODE_BIN" scripts/control-panel.mjs

echo
read -k 1 "?控制台已停止，按任意键关闭..."
