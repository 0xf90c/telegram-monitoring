#!/bin/bash
# Quick start — runs all 3 processes in separate screen sessions
# Usage: ./start.sh

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# ── Check .env ────────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  echo "❌  .env not found. Copy .env.example and fill in your values."
  exit 1
fi

# ── Build frontend if not built ───────────────────────────────────────────────
if [ ! -d "telegram-dashboard/.next" ]; then
  echo "📦  Building frontend..."
  cd telegram-dashboard && npm install && npm run build && cd ..
fi

# ── Start processes in screen sessions ───────────────────────────────────────
echo "🚀  Starting userbot..."
screen -dmS userbot bash -c "cd $DIR && .venv/bin/python logger_userbot.py 2>&1 | tee logs/userbot.log"

echo "🚀  Starting API server..."
screen -dmS api bash -c "cd $DIR && .venv/bin/uvicorn dashboard_api:app --host 0.0.0.0 --port 8000 2>&1 | tee logs/api.log"

echo "🚀  Starting dashboard..."
screen -dmS dashboard bash -c "cd $DIR/telegram-dashboard && npm start 2>&1 | tee $DIR/logs/dashboard.log"

echo ""
echo "✅  All started!"
echo ""
echo "   screen -r userbot    — userbot logs"
echo "   screen -r api        — API logs"
echo "   screen -r dashboard  — dashboard logs"
echo ""
echo "   ./stop.sh            — stop everything"
echo "   ./status.sh          — check status"
