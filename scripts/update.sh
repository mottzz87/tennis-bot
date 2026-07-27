#!/usr/bin/env bash
# ============================================
# Tennis Bot - 自动更新脚本
# ============================================

set -euo pipefail

# 行缓冲，Telegram 可以实时收到输出
if command -v stdbuf >/dev/null 2>&1 && [ -z "${_LINBUF:-}" ]; then
    export _LINBUF=1
    exec stdbuf -oL -eL bash "$0" "$@"
fi

cd "$(dirname "$0")/.."

OLD_COMMIT=$(git rev-parse HEAD)

echo "📦 git fetch..."
git fetch origin
echo "✔ git fetch 完成"

echo "📦 git reset..."
git reset --hard origin/main
echo "✔ git reset 完成"

NEW_COMMIT=$(git rev-parse HEAD)

if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then

    echo "✔ 已是最新版本"

else

    if git diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" | grep -qx "package-lock.json"; then
        echo "📦 更新依赖..."
        npm ci >/dev/null 2>&1
        echo "✔ 依赖更新完成"
    else
        echo "✔ 依赖未变化"
    fi

fi

echo "📦 更新 PM2..."

case "${SERVER_ROLE:-}" in

monitor)

    if pm2 describe tennis_monitor >/dev/null 2>&1; then
        echo "🔄 重启 tennis_monitor..."
        pm2 restart tennis_monitor >/dev/null
    else
        echo "➕ 启动 tennis_monitor..."
        pm2 start apps/monitor-service/index.js --name tennis_monitor >/dev/null
    fi

    # ⚠️ 不要在这里重启 tennis_bot
    # Telegram Bot 会在 update.sh 执行结束后自行重启

    ;;

booking)

    if pm2 describe tennis_book >/dev/null 2>&1; then
        echo "🔄 重启 tennis_book..."
        pm2 restart tennis_book >/dev/null
    else
        echo "➕ 启动 tennis_book..."
        pm2 start apps/booking-service/index.js --name tennis_book >/dev/null
    fi

    ;;

*)

    echo "⚠️ SERVER_ROLE 未设置（monitor / booking），跳过 PM2"

    ;;

esac

echo "💾 保存 PM2..."
pm2 save >/dev/null

echo
echo "━━━━━━━━━━━━━━"
echo "🎉 更新成功"

if [ "${SERVER_ROLE:-}" = "monitor" ]; then
    (
        sleep 2
        pm2 restart tennis_bot
    ) &
fi