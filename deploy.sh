#!/usr/bin/env bash
#
# One-step self-host deploy for a VPS, homelab box, or any machine with
# Docker — no vendor account needed. This script:
#   - generates every secret the app needs (API token, WS secret, Garage creds)
#   - stands up self-hosted S3-compatible storage (Garage) for audio
#   - stands up Caddy in front of everything for automatic HTTPS (real domain)
#     or plain HTTP (no domain yet)
#   - computes the handful of URLs that depend on that choice
#   - builds and starts the full stack
#
# The only things it cannot invent for you are external credentials this app
# doesn't own: your Astra DB and your LLM proxy key. It prompts for those once.
#
# Usage:
#   ./deploy.sh                                    # interactive
#   DOMAIN=walfly.example.com ASTRA_DB_API_ENDPOINT=... \
#     ASTRA_DB_APPLICATION_TOKEN=... LLM_API_KEY=... ./deploy.sh   # non-interactive (CI)
#
# Safe to re-run: every value already present in .env is left untouched.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE=.env
MISSING=()

command -v docker >/dev/null 2>&1 || { echo "docker is required: https://docs.docker.com/get-docker/" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose (the v2 plugin) is required." >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }

touch "$ENV_FILE"

get_env() {
  # `grep` exiting 1 on no-match would otherwise trip `pipefail` + `set -e`
  # and kill the whole script the first time a key is still unset.
  local result
  result="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- ; true)"
  printf '%s' "$result"
}

# Writes $1=$2 into .env, but only if $1 isn't already set to a non-empty value.
set_default() {
  local key="$1" val="$2"
  [ -n "$(get_env "$key")" ] && return 0
  if grep -qE "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    echo "$key=$val" >> "$ENV_FILE"
  fi
}

# Prompts for $1 (label $2, hidden input if $3=secret) if not already set —
# via an exported env var (non-interactive) or a terminal prompt (interactive).
# Neither available → records it as missing instead of hanging forever.
require() {
  local key="$1" label="$2" secret="${3:-}"
  [ -n "$(get_env "$key")" ] && return 0
  local from_env
  from_env="$(eval echo "\${$key:-}")"
  if [ -n "$from_env" ]; then set_default "$key" "$from_env"; return 0; fi
  if [ ! -t 0 ]; then MISSING+=("$key"); return 0; fi
  local value
  if [ "$secret" = "secret" ]; then
    read -r -s -p "$label: " value; echo
  else
    read -r -p "$label: " value
  fi
  set_default "$key" "$value"
}

echo "── Walfly one-step deploy ──────────────────────────────────────────"
echo

# Fully auto-generated — never prompted for.
set_default WALFLY_API_TOKEN "$(openssl rand -hex 32)"
set_default WALFLY_WS_SECRET "$(openssl rand -hex 32)"
set_default GARAGE_DEFAULT_ACCESS_KEY "GK$(openssl rand -hex 16)"
set_default GARAGE_DEFAULT_SECRET_KEY "$(openssl rand -hex 32)"
set_default S3_BUCKET "walfly-audio"
set_default GARAGE_DEFAULT_BUCKET "$(get_env S3_BUCKET)"
set_default ASR_MODEL "small.en"
set_default LLM_BASE_URL "https://openrouter.ai/api/v1"
set_default LLM_MODEL "openai/gpt-oss-20b"
set_default CORS_ALLOW_ORIGIN "*"

# Irreducible external credentials — nothing can auto-generate these.
require ASTRA_DB_API_ENDPOINT "Astra DB API endpoint (https://<db-id>-<region>.apps.astra.datastax.com)"
require ASTRA_DB_APPLICATION_TOKEN "Astra DB application token (AstraCS:...)" secret
require LLM_API_KEY "LLM proxy API key (e.g. an OpenRouter key)" secret

# DOMAIN is genuinely optional (blank = plain HTTP) — unlike require(), a
# blank non-interactive value here is a valid answer, not a missing one.
if [ -z "$(get_env DOMAIN)" ]; then
  domain_from_env="${DOMAIN:-}"
  if [ -n "$domain_from_env" ]; then
    set_default DOMAIN "$domain_from_env"
  elif [ -t 0 ]; then
    read -r -p "Domain pointed at this machine (DNS A record), or leave blank for plain HTTP: " domain_value
    set_default DOMAIN "$domain_value"
  fi
fi

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo
  echo "No terminal to prompt on, and these are still unset. Export them or add" >&2
  echo "them to .env, then re-run ./deploy.sh:" >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  exit 1
fi

DOMAIN_VALUE="$(get_env DOMAIN)"
if [ -n "$DOMAIN_VALUE" ]; then
  SCHEME=https; WS_SCHEME=wss; HOST_FOR_URLS="$DOMAIN_VALUE"
  set_default CADDY_ADDRESS "$DOMAIN_VALUE"
else
  SCHEME=http; WS_SCHEME=ws; HOST_FOR_URLS="localhost"
  set_default CADDY_ADDRESS ":80"
  echo
  echo "No domain set — serving over plain HTTP. Swap 'localhost' below for this"
  echo "machine's real IP/hostname wherever another device needs to reach it."
fi

# Garage is the storage backend by default (see docker-compose.yml's comment
# for swapping to real S3/R2 instead). These point the API at it. Garage's
# anonymous-read feature resolves the bucket from the Host header (rewritten
# by Caddy), not from the URL path, so no bucket name in the public base URL.
set_default S3_ENDPOINT "http://garage:3900"
set_default S3_REGION "garage"
set_default S3_ACCESS_KEY_ID "$(get_env GARAGE_DEFAULT_ACCESS_KEY)"
set_default S3_SECRET_ACCESS_KEY "$(get_env GARAGE_DEFAULT_SECRET_KEY)"
set_default S3_PUBLIC_BASE_URL "$SCHEME://$HOST_FOR_URLS/media"

# The one trap from the manual setup, solved by construction: this is always
# the real public address now, never the Docker-internal one.
set_default SIDECAR_WS_URL "$WS_SCHEME://$HOST_FOR_URLS/v1/stream"

# garage.toml holds the RPC secret Garage uses to talk to itself — generated
# once here (gitignored) rather than committed, like every other secret.
if [ ! -f garage.toml ]; then
  RPC_SECRET="$(openssl rand -hex 32)"
  sed "s/REPLACE_ME_WITH_openssl_rand_-hex_32/$RPC_SECRET/" garage.toml.example > garage.toml
fi

echo
echo "Building and starting the stack (api, sidecar, garage, caddy)…"
docker compose up -d --build

echo
echo "Making the audio bucket publicly readable…"
GARAGE_READY=""
for _ in $(seq 1 30); do
  if docker compose exec -T garage /garage bucket website --allow "$(get_env S3_BUCKET)" >/dev/null 2>&1; then
    GARAGE_READY=1
    break
  fi
  sleep 2
done
if [ -z "$GARAGE_READY" ]; then
  echo "Warning: couldn't confirm the bucket is public-read — check 'docker compose logs garage'." >&2
fi

echo
echo "Waiting for the API to report healthy…"
READY=""
for _ in $(seq 1 30); do
  if docker compose exec -T api node -e \
    "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done

echo
echo "── Done ─────────────────────────────────────────────────────────────"
echo "App:        $SCHEME://$HOST_FOR_URLS/"
echo "Health:     $SCHEME://$HOST_FOR_URLS/api/health"
echo "API token:  $(get_env WALFLY_API_TOKEN)"
echo "            (enter this in the app on first launch — it's also in .env)"
if [ -z "$DOMAIN_VALUE" ]; then
  echo
  echo "To get automatic HTTPS: point a domain's DNS A record at this machine,"
  echo "add DOMAIN=yourdomain.com to .env, then re-run ./deploy.sh."
fi
echo
echo "For the mobile app, set in apps/mobile/.env.production:"
echo "  EXPO_PUBLIC_API_URL=$SCHEME://$HOST_FOR_URLS"
echo "See SETUP.md's Deployment section for the iOS release steps."
if [ -z "$READY" ]; then
  echo
  echo "Warning: the API didn't report healthy within 60s — check 'docker compose logs api'." >&2
fi
