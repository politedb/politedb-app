#!/usr/bin/env bash
# Optional instant wake for Grok Bot dual-agent handoff.
# Primary path: set .agent/PLAN.md Status to APPROVED (or REVIEW to CHANGES REQUIRED);
# Grok Bot polls every ~5 minutes on weekdays. Webhooks are optional.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTION="${1:-status}"
CONFIG="${GROK_WEBHOOK_ENV_FILE:-$HOME/.config/politedb/grok-webhooks.env}"

# Parse only known dotenv assignments. Never execute the credentials file.
if [[ -f "$CONFIG" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    if [[ "$line" =~ ^(GROK_(IMPLEMENT_PLAN|FIX_REVIEW)_WEBHOOK_(URL|KEY))=(.*)$ ]]; then
      name="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[4]}"
      if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
        value="${value:1:${#value}-2}"
      fi
      [[ -n "${!name:-}" ]] || printf -v "$name" '%s' "$value"
    else
      echo "Invalid webhook configuration assignment." >&2
      exit 1
    fi
  done < "$CONFIG"
fi

check_config() {
  local prefix url_name key_name url
  for prefix in IMPLEMENT_PLAN FIX_REVIEW; do
    url_name="GROK_${prefix}_WEBHOOK_URL"
    key_name="GROK_${prefix}_WEBHOOK_KEY"
    url="${!url_name:-}"
    if [[ "$url" != https://* || -z "${!key_name:-}" ]]; then
      echo "$prefix: missing key or invalid HTTPS URL." >&2
      return 1
    fi
    echo "$prefix: configured (values hidden)."
  done
}

plan_status() {
  awk '/^## Status$/{getline; while($0 ~ /^$/ || $0 ~ /^<!--/){getline} print; exit}' "$ROOT/.agent/PLAN.md" 2>/dev/null || true
}
review_status() {
  awk '/^Status:/{print $2; exit}' "$ROOT/.agent/REVIEW.md" 2>/dev/null || true
}

case "$ACTION" in
  check)
    check_config
    ;;
  status)
    echo "PLAN:   $(plan_status)"
    echo "REVIEW: $(review_status)"
    echo "Poll: Grok Bot checks ~every 5 min, weekdays 09–18 Asia/Saigon."
    ;;
  implement)
    if [[ -z "${GROK_IMPLEMENT_PLAN_WEBHOOK_URL:-}" || -z "${GROK_IMPLEMENT_PLAN_WEBHOOK_KEY:-}" ]]; then
      echo "No webhook env set. Ensure PLAN Status is APPROVED; Grok Bot will pick it up on poll."
      echo "PLAN: $(plan_status)"
      exit 0
    fi
    curl -sS -X POST "$GROK_IMPLEMENT_PLAN_WEBHOOK_URL" \
      -H "Authorization: Bearer $GROK_IMPLEMENT_PLAN_WEBHOOK_KEY" \
      -H "Content-Type: application/json" \
      -d '{"action":"implement","repo":"politedb-app"}'
    echo
    ;;
  fix)
    if [[ -z "${GROK_FIX_REVIEW_WEBHOOK_URL:-}" || -z "${GROK_FIX_REVIEW_WEBHOOK_KEY:-}" ]]; then
      echo "No webhook env set. Ensure REVIEW Status is CHANGES REQUIRED; Grok Bot will pick it up on poll."
      echo "REVIEW: $(review_status)"
      exit 0
    fi
    curl -sS -X POST "$GROK_FIX_REVIEW_WEBHOOK_URL" \
      -H "Authorization: Bearer $GROK_FIX_REVIEW_WEBHOOK_KEY" \
      -H "Content-Type: application/json" \
      -d '{"action":"fix","repo":"politedb-app"}'
    echo
    ;;
  *)
    echo "Usage: $0 {status|check|implement|fix}"
    exit 1
    ;;
esac
