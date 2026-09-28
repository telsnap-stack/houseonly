#!/bin/bash
# Despliegue del worker con dos frenos que abortan.
#
# POR QUE EXISTE
# El 2026-09-28 se desplego a produccion desde `claude/genero-garage`, una rama
# que iba 43 commits por detras de main. El worker resultante no tenia
# external.ts, sets.ts, events.ts, mixcloud.ts ni sync-alerts.ts: 19 rutas vivas
# desaparecieron de produccion hasta que se revertio. `wrangler deploy` sube lo
# que hay en disco y no sabe nada de git, asi que nada lo impidio.
#
# USO
#   ./scripts/deploy.sh            → produccion
#   ./scripts/deploy.sh staging    → staging
#
# Para saltarse los frenos (emergencia, y sabiendo lo que se hace):
#   DEPLOY_SIN_FRENOS=1 ./scripts/deploy.sh
set -euo pipefail

ENTORNO="${1:-produccion}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$RAIZ/src/index.ts"
cd "$RAIZ"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
gris()  { printf '\033[2m%s\033[0m\n' "$*"; }

abortar() {
  rojo "✗ ABORTADO: $1"
  shift
  for l in "$@"; do echo "   $l"; done
  echo
  echo "   Si de verdad quieres seguir: DEPLOY_SIN_FRENOS=1 $0 ${ENTORNO}"
  exit 1
}

if [ "${DEPLOY_SIN_FRENOS:-0}" = "1" ]; then
  rojo "⚠ FRENOS DESACTIVADOS (DEPLOY_SIN_FRENOS=1)"
else
  echo "Comprobando antes de desplegar a ${ENTORNO}…"
  git fetch origin --quiet

  # ── FRENO 1: la rama tiene que contener main ──────────────────
  # Sin esto se despliega codigo mas viejo que produccion y se borran rutas.
  if ! git merge-base --is-ancestor origin/main HEAD; then
    FALTAN="$(git rev-list --count HEAD..origin/main)"
    abortar "esta rama NO contiene origin/main" \
      "Le faltan ${FALTAN} commit(s). Desplegar desde aqui puede tumbar rutas vivas." \
      "Arreglo:  git merge origin/main"
  fi
  verde "✓ la rama contiene origin/main"

  # ── FRENO 2: ninguna ruta de main puede desaparecer ───────────
  # Se compara el index.ts EN DISCO (que es lo que sube wrangler) contra el de
  # main. Cualquier `action === '...'` que exista en main y no aqui es una ruta
  # que el despliegue borraria.
  RUTAS_MAIN="$(git show origin/main:houseonly-worker/houseonly-worker/src/index.ts \
    | grep -o "action === '[a-z0-9-]*'" | sort -u)"
  RUTAS_DISCO="$(grep -o "action === '[a-z0-9-]*'" "$INDEX" | sort -u)"
  PERDIDAS="$(comm -23 <(echo "$RUTAS_MAIN") <(echo "$RUTAS_DISCO") | sed "s/action === //")"
  if [ -n "$PERDIDAS" ]; then
    abortar "el despliegue borraria rutas que main si tiene" \
      "$(echo "$PERDIDAS" | tr '\n' ' ')"
  fi
  NUEVAS="$(comm -13 <(echo "$RUTAS_MAIN") <(echo "$RUTAS_DISCO") | sed "s/action === //" | tr '\n' ' ')"
  verde "✓ no se pierde ninguna ruta de main ($(echo "$RUTAS_DISCO" | wc -l | tr -d ' ') en total)"
  [ -n "$NUEVAS" ] && gris "  rutas nuevas en este despliegue: ${NUEVAS}"

  # ── FRENO 3: borrados masivos en el codigo del worker ─────────
  BORRADOS="$(git diff --numstat origin/main...HEAD -- src/ \
    | awk '{s+=$2} END {print s+0}')"
  if [ "$BORRADOS" -gt 300 ]; then
    abortar "borra ${BORRADOS} lineas de src/ respecto a main" \
      "Eso suele ser una baseline vieja, no un cambio de verdad." \
      "Revisa:  git diff --stat origin/main...HEAD -- src/"
  fi
  gris "  borrados respecto a main en src/: ${BORRADOS} lineas"

  # ── FRENO 4: wrangler sube el DISCO, no el commit ─────────────
  SUCIO="$(git status --porcelain -- src/ | head -5)"
  if [ -n "$SUCIO" ]; then
    abortar "hay cambios sin commitear en src/" \
      "wrangler sube lo que hay en disco, asi que se desplegaria algo que no" \
      "esta en ningun commit y que nadie podra revisar despues:" \
      "$(echo "$SUCIO" | tr '\n' ' ')"
  fi
  verde "✓ src/ sin cambios pendientes"
  echo
fi

gris "HEAD $(git rev-parse --short HEAD) · rama $(git branch --show-current || echo desacoplada)"
if [ "$ENTORNO" = "staging" ]; then
  npx wrangler deploy --env staging
else
  npx wrangler deploy
fi
