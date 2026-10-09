#!/bin/bash
# Verifica el feed de Instagram (link in bio) de un worker ya desplegado:
# GET publico, POST sin Bearer = 401, add pone el disco el primero, add repetido
# no duplica y remove lo quita. Usa un handle de prueba que no existe en la
# tienda y lo deja borrado al terminar: el feed queda como estaba.
#
# USO — en un terminal normal, NO dentro de un agente:
#   ./scripts/verify-ig-feed.sh              → staging (por defecto)
#   ./scripts/verify-ig-feed.sh produccion   → produccion
#
# El Bearer se pide por teclado y no se ve al escribirlo (como verify-deploy.sh).
set -uo pipefail

ENTORNO="${1:-staging}"
if [ "$ENTORNO" = "produccion" ]; then
  URL="https://houseonly-worker.emontagut.workers.dev"
else
  URL="https://houseonly-worker-staging.emontagut.workers.dev"
fi
H="zz-verify-ig-feed"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
fallos=0
ok()  { verde "✓ $*"; }
mal() { rojo  "✗ $*"; fallos=$((fallos+1)); }

echo "Verificando ${URL}"

# Sin Bearer: GET publico y POST rechazado.
c=$(curl -s -o /dev/null -w '%{http_code}' "$URL/?action=ig-feed")
[ "$c" = "200" ] && ok "GET ig-feed sin auth → 200" || mal "GET ig-feed sin auth → $c"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$URL/?action=ig-feed-add" -H 'Content-Type: application/json' -d "{\"handle\":\"$H\"}")
[ "$c" = "401" ] && ok "POST ig-feed-add sin Bearer → 401" || mal "POST ig-feed-add sin Bearer → $c"

if [ -z "${BS:-}" ]; then
  printf 'Bearer de %s (no se vera al escribir): ' "$ENTORNO"
  read -rs BS
  echo
fi
[ -z "$BS" ] && { rojo "✗ sin Bearer no se prueban add/remove"; exit 2; }

post() { curl -s -X POST "$URL/?action=$1" -H "Authorization: Bearer $BS" -H 'Content-Type: application/json' -d "$2"; }
primero() { python3 -c 'import json,sys; d=json.load(sys.stdin); i=d.get("items",[]); print(i[0]["handle"] if i else "")'; }
cuenta()  { python3 -c "import json,sys; print(sum(1 for i in json.load(sys.stdin).get('items',[]) if i['handle']=='$H'))"; }

r=$(post ig-feed-add "{\"handle\":\"$H\",\"sku\":\"TEST\",\"title\":\"verify\",\"artist\":\"verify\"}")
[ "$(echo "$r" | primero)" = "$H" ] && ok "add → el primero" || mal "add: $r"
r=$(post ig-feed-add "{\"handle\":\"$H\",\"sku\":\"TEST\",\"title\":\"verify\",\"artist\":\"verify\"}")
[ "$(echo "$r" | cuenta)" = "1" ] && ok "add repetido → no duplica" || mal "add repetido: $r"
r=$(post ig-feed-remove "{\"handle\":\"$H\"}")
[ "$(echo "$r" | cuenta)" = "0" ] && ok "remove → quitado" || mal "remove: $r"

echo
[ "$fallos" = 0 ] && verde "Todo bien." || { rojo "$fallos fallo(s)."; exit 1; }
