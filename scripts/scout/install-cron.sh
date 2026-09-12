#!/usr/bin/env bash
# Instala el vigia como tarea de los lunes (launchd, no cron de Claude: esto
# tiene que correr aunque no haya ninguna sesion abierta).
#
#   bash scripts/scout/install-cron.sh          instala
#   bash scripts/scout/install-cron.sh --off     lo quita
#
# Los secretos NO van aqui ni al repo: viven en ~/.houseonly-scout.env, que el
# trabajo lee al arrancar.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ETIQUETA="store.houseonly.scout"
PLIST="$HOME/Library/LaunchAgents/$ETIQUETA.plist"
ENTORNO="$HOME/.houseonly-scout.env"
LOG="$HOME/Library/Logs/houseonly-scout.log"

if [ "${1:-}" = "--off" ]; then
  launchctl bootout "gui/$(id -u)/$ETIQUETA" 2>/dev/null || true
  rm -f "$PLIST"
  echo "  vigia desinstalado"
  exit 0
fi

if [ ! -f "$ENTORNO" ]; then
  cat > "$ENTORNO" <<ENV
# Vigia de tiendas. Sin SCOUT_BEARER el informe se genera pero NO se manda.
SCOUT_TO=
SCOUT_BEARER=
ENV
  chmod 600 "$ENTORNO"
  echo "  creado $ENTORNO — rellena SCOUT_TO y SCOUT_BEARER"
fi

mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$ETIQUETA</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>set -a; [ -f "$ENTORNO" ] &amp;&amp; . "$ENTORNO"; set +a; cd "$REPO" &amp;&amp; node scripts/scout/scout.mjs &amp;&amp; node scripts/scout/report.mjs &amp;&amp; node scripts/scout/send.mjs</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>7</integer></dict>
  <!-- launchd guarda los disparos perdidos: si el lunes a las 8:07 el portatil
       estaba apagado, el trabajo corre al encenderlo. -->
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$ETIQUETA" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "  vigia instalado: lunes 8:07"
echo "  log en $LOG"
echo "  para probarlo ahora: launchctl kickstart gui/$(id -u)/$ETIQUETA"
