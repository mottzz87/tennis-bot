#!/usr/bin/env bash
# ============================================
# Tennis Bot - 自动更新脚本
# 每步输出一行状态，由 Telegram Bot 实时捕获
# ============================================

set -e

# 强制 stdout 行缓冲：重新 exec 自己，stdbuf -oL 保证每行 echo 立即写出
if command -v stdbuf &>/dev/null && [ -z "${_LINBUF:-}" ]; then
  export _LINBUF=1
  exec stdbuf -oL bash "$0" "$@"
fi

cd "$(dirname "$0")/.."

echo '📦 git fetch...'
git fetch origin
echo '✔ git fetch 完成'

echo '📦 git reset...'
git reset --hard origin/main
echo '✔ git reset 完成'

echo '📦 npm install...'
npm ci
echo '✔ npm install 完成'

case "${SERVER_ROLE}" in
monitor)
    echo '📦 重启 tennis_monitor...'
    pm2 restart tennis_monitor
    echo '✔ tennis_monitor 已重启'
    ;;
booking)
    echo '📦 重启 tennis_book...'
    pm2 restart tennis_book
    echo '✔ tennis_book 已重启'
    ;;
*)
    echo '⚠️ SERVER_ROLE 未设置，跳过服务重启'
    ;;
esac

pm2 save

echo '🎉 更新成功'
