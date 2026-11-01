#!/usr/bin/env bash
# Wrapper around docker compose, the Linux twin of infra/compose.ps1.
#
# The compose file lives in infra/, and compose looks for the environment file next to that file (or
# in the current directory), not next to the repository root where .env actually is. Passing it
# explicitly is the whole reason this wrapper exists:
#
#   bash infra/compose.sh up -d                     # the whole stack
#   bash infra/compose.sh dev up                    # game server + panel, capture client stopped
#   bash infra/compose.sh logs -f stream
#   bash infra/compose.sh up -d --force-recreate hlds
#
# `dev` is the cheap mode: the client renders through llvmpipe (software OpenGL) and holds ~1.6 cores
# on its own, while the panel and the donations need none of it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root/.env"
compose_file="$root/infra/docker-compose.yml"

if [ ! -f "$env_file" ]; then
  printf 'compose: missing %s - copy .env.example to .env and fill in RCON_PASSWORD and ADMIN_TOKEN\n' "$env_file" >&2
  exit 1
fi

cd "$root"

if [ "${1:-}" = "dev" ]; then
  shift
  # Stop the capture client first: with it running there is no point starting anything else, and
  # `--scale stream=0` is not allowed next to an explicit service list.
  docker compose --env-file "$env_file" -f "$compose_file" stop stream || true
  exec docker compose --env-file "$env_file" -f "$compose_file" up -d hlds control-api "$@"
fi

exec docker compose --env-file "$env_file" -f "$compose_file" "$@"
