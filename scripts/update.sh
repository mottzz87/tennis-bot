#!/usr/bin/env bash
# ============================================
# Tennis Bot - Update Script
# ============================================

set -euo pipefail

cd "$(dirname "$0")/.."

OLD_COMMIT=$(git rev-parse HEAD)

echo "📦 git fetch..."
git fetch origin >/dev/null 2>&1
echo "✔ git fetch 完成"

echo "📦 git reset..."
git reset --hard origin/main >/dev/null 2>&1
git reset 完成

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

case "${SERVER_ROLE:-}" in

monitor)

    if pm2 describe tennis_monitor >/dev/null 2>&1; then
        pm2 restart tennis_monitor >/dev/null
    else
        pm2 start apps/monitor-service/index.js \
            --name tennis_monitor >/dev/null
    fi

    ;;

booking)

    if pm2 describe tennis_book >/dev/null 2>&1; then
        pm2 restart tennis_book >/dev/null
    else
        pm2 start apps/booking-service/index.js \
            --name tennis_book >/dev/null
    fi

    ;;

*)

    echo "⚠️ SERVER_ROLE 未设置（monitor / booking）"

    ;;

esac

pm2 save >/dev/null