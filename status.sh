#!/bin/bash
# Check status of all services
# Usage: ./status.sh

check() {
  local name=$1
  screen -list | grep -q "$name" && echo "   ✅  $name  — running" || echo "   ❌  $name  — stopped"
}

echo ""
echo "── Service Status ───────────────────────────────"
check "userbot"
check "api"
check "dashboard"
echo "─────────────────────────────────────────────────"
echo ""
echo "Logs: tail -f logs/userbot.log | logs/api.log | logs/dashboard.log"
echo ""
