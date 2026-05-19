#!/usr/bin/env bash
# houseonly-redirect-allinone.sh
#
# One-shot script that:
#   1. Verifies API token works
#   2. Resolves Zone ID for houseonly.store
#   3. Checks that www.houseonly.store is proxied through Cloudflare (DNS)
#   4. Checks if a Redirect-Rules ruleset already exists for the zone
#   5. Creates or updates the rule (www -> apex, 301, preserve query string)
#   6. Verifies the redirect actually works
#
# Requires:
#   export CLOUDFLARE_API_TOKEN="<your token with Zone:Read + Single Redirect:Edit>"
#
# Run with:
#   bash houseonly-redirect-allinone.sh

set -u
RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[0;33m'; BLU=$'\033[0;34m'; RST=$'\033[0m'
API="https://api.cloudflare.com/client/v4"
PHASE="http_request_dynamic_redirect"
APEX="houseonly.store"
WWW="www.houseonly.store"

fail() { echo "${RED}✗ $1${RST}" >&2; exit 1; }
ok()   { echo "${GRN}✓ $1${RST}"; }
info() { echo "${BLU}→ $1${RST}"; }
warn() { echo "${YLW}! $1${RST}"; }

# ── Pre-flight ────────────────────────────────────────────────────────────────
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "CLOUDFLARE_API_TOKEN env var is not set. Run: export CLOUDFLARE_API_TOKEN=\"<your token>\""
command -v jq >/dev/null 2>&1 || fail "jq is required. Install: brew install jq"

# ── 1. Token works? ───────────────────────────────────────────────────────────
info "Step 1: verifying API token..."
TOKEN_CHECK=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/user/tokens/verify")
if [[ "$(echo "$TOKEN_CHECK" | jq -r '.success')" != "true" ]]; then
  echo "$TOKEN_CHECK" | jq .
  fail "Token verification failed. Check the token is valid and not expired."
fi
ok "Token is valid"

# ── 2. Resolve Zone ID ────────────────────────────────────────────────────────
info "Step 2: resolving Zone ID for $APEX..."
ZONE_RESP=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/zones?name=$APEX")
if [[ "$(echo "$ZONE_RESP" | jq -r '.success')" != "true" ]]; then
  echo "$ZONE_RESP" | jq .
  fail "Zones list call failed."
fi
ZONE_ID=$(echo "$ZONE_RESP" | jq -r '.result[0].id // empty')
if [[ -z "$ZONE_ID" ]]; then
  fail "Token does not have access to zone $APEX. Add 'Zone:Read' permission for this zone."
fi
ok "Zone ID: $ZONE_ID"

# ── 3. DNS proxy status ───────────────────────────────────────────────────────
info "Step 3: checking that $WWW is proxied through Cloudflare..."
DNS_RESP=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/zones/$ZONE_ID/dns_records?name=$WWW")
WWW_RECORD=$(echo "$DNS_RESP" | jq -r '.result[0] // empty')
if [[ -z "$WWW_RECORD" || "$WWW_RECORD" == "null" ]]; then
  warn "No DNS record for $WWW found in Cloudflare."
  warn "Without a DNS record, $WWW won't resolve at all."
  warn "Continuing — but the redirect rule won't fire because traffic never reaches Cloudflare."
else
  WWW_PROXIED=$(echo "$WWW_RECORD" | jq -r '.proxied')
  WWW_TYPE=$(echo "$WWW_RECORD" | jq -r '.type')
  WWW_CONTENT=$(echo "$WWW_RECORD" | jq -r '.content')
  if [[ "$WWW_PROXIED" == "true" ]]; then
    ok "$WWW is proxied ($WWW_TYPE → $WWW_CONTENT)"
  else
    warn "$WWW exists but is NOT proxied (proxied=$WWW_PROXIED, $WWW_TYPE → $WWW_CONTENT)"
    warn "The Cloudflare redirect rule only fires on proxied traffic."
    warn "You may want to enable the orange cloud for this record. Continuing for now."
  fi
fi

# Independent verification: does www.houseonly.store currently respond?
WWW_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -I "https://$WWW/" || echo "000")
info "Current HTTPS response for $WWW: $WWW_STATUS (will become 301 after this script runs successfully)"

# ── 4. Existing ruleset? ──────────────────────────────────────────────────────
info "Step 4: checking for existing $PHASE entrypoint ruleset..."
EXISTING=$(curl -sS -o /tmp/cf-existing.json -w "%{http_code}" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$API/zones/$ZONE_ID/rulesets/phases/$PHASE/entrypoint")

EXISTING_ID=""
if [[ "$EXISTING" == "200" ]]; then
  EXISTING_ID=$(jq -r '.result.id' /tmp/cf-existing.json)
  EXISTING_RULES_COUNT=$(jq -r '.result.rules | length' /tmp/cf-existing.json)
  ok "Found existing ruleset: $EXISTING_ID (currently has $EXISTING_RULES_COUNT rule(s))"
  if [[ "$EXISTING_RULES_COUNT" -gt 0 ]]; then
    warn "Existing rules will be REPLACED by this script's www→apex rule."
    warn "Existing rules in the ruleset:"
    jq -r '.result.rules[] | "  - " + (.description // .ref // .id)' /tmp/cf-existing.json
    echo ""
    read -r -p "Continue and overwrite? [y/N] " ANS
    [[ "$ANS" =~ ^[yY]$ ]] || fail "Aborted by user."
  fi
elif [[ "$EXISTING" == "404" ]]; then
  ok "No existing ruleset — will create a fresh one"
else
  cat /tmp/cf-existing.json | jq . 2>/dev/null || cat /tmp/cf-existing.json
  fail "Unexpected status code $EXISTING when checking entrypoint ruleset."
fi

# ── 5. Create or update ───────────────────────────────────────────────────────
info "Step 5: applying the redirect rule..."
read -r -d '' RULES_JSON <<'JSON' || true
[
  {
    "ref": "www_to_apex_301",
    "description": "Redirect www.houseonly.store to apex (301, preserve path + query)",
    "expression": "(http.host eq \"www.houseonly.store\")",
    "action": "redirect",
    "action_parameters": {
      "from_value": {
        "target_url": {
          "expression": "concat(\"https://houseonly.store\", http.request.uri.path)"
        },
        "status_code": 301,
        "preserve_query_string": true
      }
    },
    "enabled": true
  }
]
JSON
BODY=$(jq -n --argjson rules "$RULES_JSON" --arg phase "$PHASE" '{
  name: "Redirect rules ruleset",
  kind: "zone",
  phase: $phase,
  rules: $rules
}')

if [[ -n "$EXISTING_ID" ]]; then
  info "PUT $API/zones/$ZONE_ID/rulesets/$EXISTING_ID"
  RESP=$(curl -sS --request PUT \
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    --header "Content-Type: application/json" \
    --data "$BODY" \
    "$API/zones/$ZONE_ID/rulesets/$EXISTING_ID")
else
  info "POST $API/zones/$ZONE_ID/rulesets"
  RESP=$(curl -sS --request POST \
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    --header "Content-Type: application/json" \
    --data "$BODY" \
    "$API/zones/$ZONE_ID/rulesets")
fi

if [[ "$(echo "$RESP" | jq -r '.success')" != "true" ]]; then
  echo "$RESP" | jq .
  fail "Ruleset apply failed."
fi
RULE_ID=$(echo "$RESP" | jq -r '.result.rules[0].id')
ok "Redirect rule applied. Rule ID: $RULE_ID"

# ── 6. Post-deploy verification ──────────────────────────────────────────────
info "Step 6: waiting 8s for propagation, then verifying the redirect..."
sleep 8

TEST_HEADERS=$(curl -sSI "https://$WWW/" || true)
TEST_STATUS=$(echo "$TEST_HEADERS" | awk 'NR==1{print $2}')
TEST_LOCATION=$(echo "$TEST_HEADERS" | awk -F': ' 'tolower($1)=="location"{sub(/\r$/,"",$2); print $2}')

if [[ "$TEST_STATUS" == "301" && "$TEST_LOCATION" == "https://houseonly.store/" ]]; then
  ok "Redirect works: $WWW → $TEST_LOCATION (301)"
elif [[ "$TEST_STATUS" == "301" ]]; then
  warn "Got 301 but unexpected Location: $TEST_LOCATION"
else
  warn "Expected 301, got $TEST_STATUS. Headers:"
  echo "$TEST_HEADERS"
  warn "If status is still 200, propagation may need more time. Re-run: curl -sI https://$WWW/"
fi

# Also test with a path + query
TEST2=$(curl -sSI "https://$WWW/products/test?utm=foo" || true)
TEST2_STATUS=$(echo "$TEST2" | awk 'NR==1{print $2}')
TEST2_LOCATION=$(echo "$TEST2" | awk -F': ' 'tolower($1)=="location"{sub(/\r$/,"",$2); print $2}')
info "Path+query test: status=$TEST2_STATUS, location=$TEST2_LOCATION"
if [[ "$TEST2_LOCATION" == "https://houseonly.store/products/test?utm=foo" ]]; then
  ok "Path and query string are preserved"
fi

echo ""
ok "Done. Next: deploy the index.html canonical tag and start a new validation in Google Search Console."
