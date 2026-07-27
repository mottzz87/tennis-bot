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

# 没有任何更新
if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
    echo "✔ 已是最新版本"

else

    # package-lock.json 有变化才安装依赖
    if git diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" | grep -qx "package-lock.json"; then
        echo "📦 package-lock.json 已更新"
        echo "📦 npm ci..."
        npm ci
        echo "✔ npm install 完成"
    else
        echo "✔ package-lock 未变化，跳过 npm install"
    fi

fi

echo "📦 更新 PM2..."

case "${SERVER_ROLE:-}" in

monitor)

    if pm2 describe tennis_monitor >/dev/null 2>&1; then
        echo "🔄 重启 tennis_monitor..."
        pm2 restart tennis_monitor
    else
        echo "➕ 启动 tennis_monitor..."
        pm2 start apps/monitor-service/index.js --name tennis_monitor
    fi

    if pm2 describe tennis_bot >/dev/null 2>&1; then
        echo "🔄 重启 tennis_bot..."
        pm2 restart tennis_bot
    else
        echo "➕ 启动 tennis_bot..."
        pm2 start apps/telegram-bot/index.js --name tennis_bot
    fi
    ;;

booking)

    if pm2 describe tennis_book >/dev/null 2>&1; then
        echo "🔄 重启 tennis_book..."
        pm2 restart tennis_book
    else
        echo "➕ 启动 tennis_book..."
        pm2 start apps/booking-service/index.js --name tennis_book
    fi
    ;;

*)

    echo "⚠️ SERVER_ROLE 未设置（monitor / booking），跳过 PM2"
    ;;

esac

echo "💾 保存 PM2..."
pm2 save

echo
echo "━━━━━━━━━━━━━━"
echo "🎉 更新成功"