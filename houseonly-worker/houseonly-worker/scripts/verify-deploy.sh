#!/bin/bash
# Verifica un worker ya desplegado: que no falte ninguna ruta y que mt-enrich y
# mirror-audio funcionen de verdad.
#
# USO — en un terminal normal, NO dentro de un agente:
#   ./scripts/verify-deploy.sh              → produccion
#   ./scripts/verify-deploy.sh staging      → staging
#
# El Bearer se pide por teclado y no se ve al escribirlo, asi que no queda en el
# historial del shell ni en ningun fichero. Si prefieres pasarlo por entorno:
#   BS='...' ./scripts/verify-deploy.sh
# (ojo: eso SI queda en el historial salvo que lo lances con un espacio delante).
#
# POR QUE EXISTE
# El 28-09 un despliegue desde una rama vieja borro 19 rutas de produccion y no
# se noto hasta mirar un diff. Esto lo habria cantado en 30 segundos.
set -uo pipefail

ENTORNO="${1:-produccion}"
if [ "$ENTORNO" = "staging" ]; then
  URL="https://houseonly-worker-staging.emontagut.workers.dev"
else
  URL="https://houseonly-worker.emontagut.workers.dev"
fi

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
gris()  { printf '\033[2m%s\033[0m\n' "$*"; }

if [ -z "${BS:-}" ]; then
  printf 'Bearer de %s (no se vera al escribir): ' "$ENTORNO"
  read -rs BS
  echo
fi
if [ -z "$BS" ]; then rojo "✗ sin Bearer no hay verificacion"; exit 2; fi

echo "Verificando ${URL}"
echo

# ── 1. ¿Existen todas las rutas? ─────────────────────────────────
# No se miran codigos HTTP: enganan. mirror-audio con GET devuelve 200 porque
# exige POST y cae al fallback de accion desconocida. Lo que se mira es si la
# respuesta ES ese fallback: {"imageUrl":""} en GET, {"error":"Unknown action"}
# en POST. La accion de control existe para probar que el check sabe decir NO.
RUTAS=(
  events-get events-put
  external-gaps external-get external-review-approve external-review-approve-bulk
  external-review-list external-review-put external-review-reject
  mixcloud-refresh
  sets-add sets-list sets-order sets-remove
  sets-review-approve sets-review-list sets-review-put sets-review-reject
  sync-relink
  mt-enrich mirror-audio
  accion-de-control-que-no-existe
)
falta=0; presentes=0
for a in "${RUTAS[@]}"; do
  g=$(curl -s --max-time 25 -H "Authorization: Bearer $BS" "$URL/?action=$a")
  p=$(curl -s --max-time 25 -X POST -H "Authorization: Bearer $BS" \
        -H 'Content-Type: application/json' -d '{}' "$URL/?action=$a")
  if [ "$g" = '{"imageUrl":""}' ] && [ "$p" = '{"error":"Unknown action"}' ]; then
    if [ "$a" = "accion-de-control-que-no-existe" ]; then
      verde "✓ control: el check sabe detectar una ruta ausente"
    else
      rojo "✗ FALTA  $a"; falta=$((falta+1))
    fi
  else
    if [ "$a" = "accion-de-control-que-no-existe" ]; then
      rojo "✗ el control deberia faltar y no falta — el check no vale"; falta=$((falta+1))
    else
      presentes=$((presentes+1))
    fi
  fi
done
[ "$falta" -eq 0 ] && verde "✓ ${presentes}/21 rutas presentes" || rojo "✗ faltan ${falta}"

# ── 2. mt-enrich de verdad ───────────────────────────────────────
# MBH001/002 va a proposito: el catno con barra es el caso que mas cuesta.
echo
J=$(curl -s --max-time 90 -H "Authorization: Bearer $BS" \
      "$URL/?action=mt-enrich&catnos=LEMAN006,MBH001/002")
echo "$J" | python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except Exception:
    print("  no devolvio JSON:", raw[:200]); sys.exit(1)
if "releases" not in d:
    print("  respuesta inesperada:", json.dumps(d)[:200]); sys.exit(1)
mal = 0
for r in d["releases"]:
    falla = [k for k in ("artist", "title", "label", "format_hint", "cover") if not r.get(k)]
    if not r.get("tracks"):
        falla.append("tracks")
    if falla:
        mal += 1
    marca = "✗" if falla else "✓"
    print("  " + marca + " " + r["catno"].ljust(12) + r["artist"] + " — " + r["title"])
    print("     " + r["label"] + " · " + r["format_hint"] + " · "
          + str(len(r["tracks"])) + " pistas · " + r["resolved_via"])
    if falla:
        print("     falta: " + ", ".join(falla))
if d.get("errors"):
    print("  ✗ errores:", d["errors"]); mal += 1
if len(d["releases"]) != 2:
    print("  ✗ se esperaban 2 fichas y vinieron " + str(len(d["releases"]))); mal += 1
sys.exit(1 if mal else 0)
'
MT=$?
[ "$MT" -eq 0 ] && verde "✓ mt-enrich devuelve fichas completas" || rojo "✗ mt-enrich"

# ── 3. mirror-audio: auth y validacion ───────────────────────────
# No se escribe en R2 a proposito: staging y produccion COMPARTEN el bucket
# houseonly-audio, asi que una prueba de escritura deja basura en el real.
echo
h=$(curl -s --max-time 25 -H "Authorization: Bearer $BS" -H 'Content-Type: application/json' \
      -X POST "$URL/?action=mirror-audio" -d '{"url":"https://example.com/x.mp3","key":"audio/x.mp3"}')
k=$(curl -s --max-time 25 -H "Authorization: Bearer $BS" -H 'Content-Type: application/json' \
      -X POST "$URL/?action=mirror-audio" -d '{"url":"https://www.mothertonguerecords.com/a.mp3","key":"../fuera.mp3"}')
MA=0
case "$h" in *"host not allowed"*) ;; *) rojo "✗ mirror-audio no rechaza un host ajeno: $h"; MA=1;; esac
case "$k" in *"invalid key"*)      ;; *) rojo "✗ mirror-audio no rechaza una clave con ../: $k"; MA=1;; esac
[ "$MA" -eq 0 ] && verde "✓ mirror-audio: auth pasa y la validacion rechaza lo que debe"

echo
if [ "$falta" -eq 0 ] && [ "$MT" -eq 0 ] && [ "$MA" -eq 0 ]; then
  verde "TODO BIEN en ${ENTORNO}"; exit 0
else
  rojo "HAY FALLOS en ${ENTORNO} — revisa arriba"
  gris "Revertir:  npx wrangler deployments list${ENTORNO:+ }$([ "$ENTORNO" = staging ] && echo '--env staging')"
  gris "           npx wrangler rollback <version-id>"
  exit 1
fi
