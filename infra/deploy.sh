#!/usr/bin/env bash
# From a fresh clone to a running stack, in one command, on a Linux host with Docker.
#
#   bash infra/deploy.sh              # preflight, build both images, then recreate the whole stack
#   bash infra/deploy.sh --no-build   # containers only (a .env change, a map added, a crash)
#   bash infra/deploy.sh --check      # read-only health report: safe on a live server
#
# Why a script and not five commands in a document: the stack has three failure modes that all look
# like "the panel is empty" from the outside - a missing .env, a data/ directory the API cannot write
# (it runs as uid 1000, not root) and an image built before the last `git pull`. Each one is checked
# before anything starts, and the report names a key or a directory, never a value: .env holds three
# secrets and this output ends up in terminals, tickets and chat logs.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/.env"
compose_file="$root/infra/docker-compose.yml"

mode="deploy"
case "${1:-}" in
  "") ;;
  --no-build) mode="restart" ;;
  --check) mode="check" ;;
  -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
  *) printf 'deploy: unknown argument %s (see --help)\n' "$1" >&2; exit 2 ;;
esac

die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
say() { printf 'deploy: %s\n' "$*"; }
warn() { printf 'deploy: warning: %s\n' "$*" >&2; }

compose() { docker compose --env-file "$env_file" -f "$compose_file" "$@"; }

# .env is read one key at a time and only for presence checks or to reach the local panel; nothing
# below prints a value that came out of it.
env_value() {
  local key="$1"
  grep -E "^${key}=" "$env_file" | tail -n 1 | cut -d= -f2- || true
}

command -v docker >/dev/null 2>&1 || die "docker is not installed - see docs/deploy.md"
docker compose version >/dev/null 2>&1 \
  || die "the docker compose plugin is missing; docker-compose v1 does not understand this file"
[ -f "$env_file" ] || die "missing $env_file - cp .env.example .env and fill in RCON_PASSWORD, ADMIN_TOKEN, YOUTUBE_STREAM_KEY"

# The images ship 32-bit GoldSrc binaries and are built for amd64: an ARM VPS would need emulation
# for both the build and every frame of the capture, so this is refused instead of tolerated.
arch="$(uname -m)"
[ "$arch" = "x86_64" ] || die "an x86_64 host is required (this one is $arch); see docs/deploy.md"

empty=()
for key in RCON_PASSWORD ADMIN_TOKEN; do
  [ -n "$(env_value "$key")" ] || empty+=("$key")
done
[ ${#empty[@]} -eq 0 ] || die "empty in .env: ${empty[*]}"
[ -n "$(env_value YOUTUBE_STREAM_KEY)" ] || warn "YOUTUBE_STREAM_KEY is empty - the capture container will not go live"
if [ "$(env_value DA_MOCK)" = "1" ]; then
  warn "DA_MOCK=1 - donations are simulated; set DA_CLIENT_ID/DA_CLIENT_SECRET for the real account"
fi

# The control API writes its SQLite history into data/, a bind mount, as uid 1000. A directory created
# by root (or by a clone done as root) fails every write with EACCES and the panel stays empty.
data_owner() { stat -c %u "$root/data" 2>/dev/null || echo 0; }

prepare_state() {
  mkdir -p "$root/data"
  if [ "$(data_owner)" != "1000" ]; then
    if [ "$(id -u)" = "0" ]; then
      chown -R 1000:1000 "$root/data"
      say "data/ handed to uid 1000"
    elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      sudo chown -R 1000:1000 "$root/data"
      say "data/ handed to uid 1000 (sudo)"
    else
      warn "data/ is not owned by uid 1000 - run: sudo chown -R 1000:1000 data"
    fi
  fi
  # The file is 600 from the moment it exists: it holds the RCON password, the panel token and the
  # YouTube stream key, and a stack that works is not worth a world-readable secret.
  chmod 600 "$env_file" 2>/dev/null || true
}

if [ "$mode" = "check" ]; then
  [ "$(data_owner)" = "1000" ] || warn "data/ belongs to uid $(data_owner), not 1000 - the API cannot write"
  compose ps

  # "donation_events loaded" is the only proof the game server read our catalogue; without it the
  # server is up and a paid donation does nothing.
  if compose logs --tail 400 hlds 2>/dev/null | grep -q "donation_events loaded"; then
    say "hlds: donation_events loaded"
  else
    say "hlds: no 'donation_events loaded' in the last 400 log lines (a fresh start logs it once per map)"
  fi

  admin_port="$(env_value ADMIN_PORT)"; admin_port="${admin_port:-8080}"
  admin_token="$(env_value ADMIN_TOKEN)"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS -m 5 -H "x-admin-token: $admin_token" "http://127.0.0.1:$admin_port/api/state" >/dev/null 2>&1; then
      say "panel: 200 on /api/state; reach it with ssh -L $admin_port:127.0.0.1:$admin_port <user>@<host>"
    else
      say "panel: /api/state did not answer with 200 on 127.0.0.1:$admin_port"
    fi
  fi

  if compose ps --status running --services 2>/dev/null | grep -qx stream; then
    frames="$(compose logs --tail 300 stream 2>/dev/null | grep -c "frame=" || true)"
    say "stream: running, $frames encoder progress line(s) in the last 300 (STREAM_FFMPEG_LOGLEVEL=info shows them)"
  else
    say "stream: not running (that is the point of \`bash infra/compose.sh dev up\`)"
  fi
  exit 0
fi

prepare_state

if [ "$mode" = "deploy" ]; then
  bash "$root/infra/build-images.sh"
  # The two images are replaced in place, and a running container keeps the image it was created
  # from: without this the deploy is a no-op that looks successful.
  compose up -d --force-recreate
else
  compose up -d
fi

say "stack is up:"
compose ps
cat <<'NEXT'

next:
  bash infra/deploy.sh --check                                  # health report
  ssh -L 8080:127.0.0.1:8080 <user>@<host>                      # the panel, nothing else is exposed
  bash infra/compose.sh logs -f stream                          # the picture
  bash infra/compose.sh dev up                                  # stop paying for the capture client

NEXT
