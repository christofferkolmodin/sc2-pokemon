#!/usr/bin/env bash
# Update the game on the VPS: pull from GitHub, install, build, restart.
# Run on the server:   sudo bash /home/game/sc2-pokemon/tools/server/update.sh
# Or from your PC:     ssh root@<server-ip> bash /home/game/sc2-pokemon/tools/server/update.sh --yes
#
# Restarting ends any match in progress, so it asks first (--yes skips the question).
# The build runs before the restart: if it fails, the running server is left alone.
set -euo pipefail

APP_USER=game
SERVICE=sc2-pokemon
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
YES=0
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && YES=1

if [[ $EUID -ne 0 ]]; then exec sudo bash "$0" "$@"; fi
as_app() { sudo -u "$APP_USER" -H bash -c "cd '$DIR' && $1"; }

echo "==> Fetching from GitHub"
as_app "git fetch --quiet"
before=$(as_app "git rev-parse HEAD")
after=$(as_app "git rev-parse @{u}")
if [[ "$before" == "$after" ]]; then
  echo "    Already up to date ($(as_app "git log -1 --format='%h %s'"))."
else
  as_app "git log --oneline HEAD..@{u}" | sed 's/^/    /'
  as_app "git pull --ff-only --quiet"
fi

echo "==> Installing packages"
as_app "npm ci --no-audit --no-fund --loglevel=error"

echo "==> Building"
as_app "npm run build --silent"

if [[ $YES -eq 0 ]]; then
  read -r -p "==> Restart now? Any match in progress will end. [y/N] " answer || answer=""
  if [[ ! "$answer" =~ ^[Yy]$ ]]; then
    echo "    Not restarted. The new version starts on the next restart: sudo systemctl restart $SERVICE"
    exit 0
  fi
fi

echo "==> Restarting $SERVICE"
systemctl restart "$SERVICE"
# npm start builds again before listening, so give it a moment.
for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:3000/robots.txt"; then
    echo "    Up: $(as_app "git log -1 --format='%h %s'")"
    exit 0
  fi
  sleep 1
done
echo "!! Server didn't answer within 30 s. Check the log: journalctl -u $SERVICE -n 50" >&2
exit 1
