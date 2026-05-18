#!/bin/bash
# Install and enable systemd services (run once as root or with sudo)
# Usage: sudo ./setup-services.sh

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
USER_NAME="$(stat -c '%U' "$DIR")"
NPM_PATH="$(which npm || echo /usr/bin/npm)"

echo "📁  Project dir : $DIR"
echo "👤  Running as  : $USER_NAME"
echo ""

# ── Create logs dir ───────────────────────────────────────────────────────────
mkdir -p "$DIR/logs"
chown "$USER_NAME":"$USER_NAME" "$DIR/logs"

# ── Build frontend if needed ──────────────────────────────────────────────────
if [ ! -d "$DIR/telegram-dashboard/.next" ]; then
  echo "📦  Building frontend (runs as $USER_NAME)..."
  su - "$USER_NAME" -c "cd $DIR/telegram-dashboard && npm install && npm run build"
fi

# ── Install service files ─────────────────────────────────────────────────────
for svc in userbot api dashboard; do
  SRC="$DIR/services/$svc.service"
  DEST="/etc/systemd/system/tg-$svc.service"

  # Replace placeholders
  sed "s|%DIR%|$DIR|g; s|%USER%|$USER_NAME|g; s|%NPM%|$NPM_PATH|g" "$SRC" > "$DEST"

  echo "   ✓ Installed: $DEST"
done

# ── Enable and start ──────────────────────────────────────────────────────────
systemctl daemon-reload

for svc in userbot api dashboard; do
  systemctl enable "tg-$svc"
  systemctl restart "tg-$svc"
  echo "   ✅  tg-$svc enabled + started"
done

echo ""
echo "Done! Services will auto-start on reboot."
echo ""
echo "Useful commands:"
echo "   systemctl status tg-userbot"
echo "   systemctl status tg-api"
echo "   systemctl status tg-dashboard"
echo "   journalctl -u tg-userbot -f    (live logs)"
echo "   journalctl -u tg-api -f"
echo ""
echo "Stop all:    sudo systemctl stop tg-userbot tg-api tg-dashboard"
echo "Start all:   sudo systemctl start tg-userbot tg-api tg-dashboard"
echo "Restart all: sudo systemctl restart tg-userbot tg-api tg-dashboard"
