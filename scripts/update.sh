#!/usr/bin/env bash
# ============================================
# Tennis Bot - Update Script
# ============================================


echo "SCRIPT: $(realpath "$0")"
echo "PWD: $(pwd)"
export FNM_PATH="$HOME/.local/share/fnm"

if [ -d "$FNM_PATH" ]; then
    export PATH="$FNM_PATH:$PATH"
    eval "$("$FNM_PATH/fnm" env --shell bash)"
fi
set -euo pipefail

cd "$(dirname "$0")/.."

OLD_COMMIT=$(git rev-parse HEAD)

echo "📦 Fetching latest code..."
git fetch origin >/dev/null

echo "📦 Updating repository..."
git reset --hard origin/main >/dev/null

NEW_COMMIT=$(git rev-parse HEAD)

if [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
    echo "✔ Already up to date"
else
    if git diff --name-only "$OLD_COMMIT" "$NEW_COMMIT" | grep -qx "package-lock.json"; then
        echo "📦 Installing dependencies..."
        npm ci >/dev/null
        echo "✔ Dependencies updated"
    else
        echo "✔ Dependencies unchanged"
    fi
fi

echo "📦 Updating services..."

case "${SERVER_ROLE:-}" in

monitor)

    if pm2 describe tennis_monitor >/dev/null 2>&1; then
        pm2 restart tennis_monitor >/dev/null
    else
        pm2 start apps/monitor-service/index.js \
            --name tennis_monitor >/dev/null
    fi

    if pm2 describe tennis_bot >/dev/null 2>&1; then
        pm2 restart tennis_bot >/dev/null
    else
        pm2 start apps/telegram-bot/index.js \
            --name tennis_bot >/dev/null
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

    echo "❌ SERVER_ROLE is not set."
    echo "Please set SERVER_ROLE=monitor or SERVER_ROLE=booking"
    exit 1

    ;;

esac

pm2 save >/dev/null

echo "━━━━━━━━━━━━━━"
echo "🎉 Update completed"