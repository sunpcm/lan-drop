#!/bin/zsh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    source "$HOME/.nvm/nvm.sh"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请安装 Node.js 22+ 后在终端运行：npm install && npm start"
  read -r "?按回车关闭..."
  exit 1
fi

if ! node -e 'const major = Number(process.versions.node.split(".")[0]); if (!Number.isSafeInteger(major) || major < 22) process.exit(1)'; then
  echo "当前 Node.js 版本为 $(node -p 'process.versions.node')，需要 22 或更高版本。"
  read -r "?按回车关闭..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行，安装项目依赖..."
  npm install
fi

npm start
