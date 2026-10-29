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

# 更新前给运行时数据做一份快照（安全网，保留最近 5 份）
BAK="data/backup/$(date +%Y%m%d%H%M%S)"
mkdir -p "$BAK"
for f in bookedSlots.json lastSet.json autoBooked.json reminderIndex.json; do
    if [ -f "data/$f" ]; then cp -f "data/$f" "$BAK/"; fi
done
# /set 会改 data/config/*.yaml（git 追踪文件）：拉取前先把 live config 也备份到同一份快照里，
# 拉取后再恢复，否则每次部署都会被脏 config 挡住（本次持续推送部署就是这么失败的）。
for f in data/config/*.yaml; do
    if [ -f "$f" ]; then cp -f "$f" "$BAK/"; fi
done
# 只保留最近 5 份备份（按修改时间，删除最旧的）
count=0
for d in $(ls -1dt data/backup/20*/ 2>/dev/null); do
    count=$((count + 1))
    if [ "$count" -gt 5 ]; then rm -rf "$d"; fi
done

OLD_COMMIT=$(git rev-parse HEAD)

echo "📦 Fetching latest code..."
git fetch origin >/dev/null

# 用 ff-only 合并代替 reset --hard：绝不删除未跟踪的数据文件；
# 若本地与远端产生分歧则直接失败（脚本退出），而不是静默清掉工作区。
echo "📦 Updating repository..."
git checkout main 2>/dev/null || true
# 先清掉 config 的本地改动（已备份），让 ff-only 能过去；代码文件仍受 ff-only 保护，脏了照样失败，不会被静默覆盖。
git checkout -- data/config/ 2>/dev/null || true
if ! git merge --ff-only origin/main >/dev/null; then
    echo "❌ Merge failed, restoring live config..."
    for f in "$BAK"/*.yaml; do
        if [ -f "$f" ]; then cp -f "$f" "data/config/$(basename "$f")"; fi
    done
    exit 1
fi
# 拉取成功后恢复 live config（只恢复备份里有的文件；上游新增的配置文件不会被覆盖）。
# 注意：恢复发生在 pm2 重启之前，所以重启后的服务读到的就是 live config。
for f in "$BAK"/*.yaml; do
    if [ -f "$f" ]; then cp -f "$f" "data/config/$(basename "$f")"; fi
done

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
