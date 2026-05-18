#!/bin/bash
# Stop all running services
# Usage: ./stop.sh

echo "🛑  Stopping all services..."

screen -S userbot  -X quit 2>/dev/null && echo "   ✓ userbot stopped"   || echo "   — userbot was not running"
screen -S api      -X quit 2>/dev/null && echo "   ✓ api stopped"       || echo "   — api was not running"
screen -S dashboard -X quit 2>/dev/null && echo "   ✓ dashboard stopped" || echo "   — dashboard was not running"

echo "Done."
