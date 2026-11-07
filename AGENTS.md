# cs16-shortchaos

CS 1.6 dedicated server with bots. Viewer donations trigger in-game activities,
streamed to YouTube. Node 24 + TypeScript; game side is AMX Mod X Pawn plugins.

## Commands

- `npm test` — node:test
- `npm run typecheck` — `tsc -p tsconfig.json`
- `npm run ui-preview` — local panel preview, no Docker and no game server
- `npm run fake-donation` — append a mock donation
- `npm start` — daemon; set `POLL_ONCE=1` for one polling pass
- `docker compose -f infra/docker-compose.yml ...` — ask before running

## Layout

- `config/activities.json`, `config/auto-events.json` — catalogue and rotation
- `src/` — donation mapping, cooldowns, RCON, pollers, panel state
- `plugins/` — Pawn plugins: donation_events, team_war, bot_antistuck
- `infra/` — HLDS image, compose, checksum and supply-chain verification
- `scripts/` — fake donation, OAuth, UI preview, map walk

## Rules

- Validate config at startup and fail fast; no silent defaults.
- Donor nicknames go through the RCON sanitizer; never interpolate raw text into commands.
- Secrets (DonationAlerts tokens, RCON password, `.env`) stay out of git and logs.
- Money math: minimum 50 RUB = one step; repeated effects merge; unknown currencies reject.
- Run `npm test`, `npm run typecheck` and `npm run ui-preview` before touching a live server.
- Do not change the live server, RCON state or Docker images without explicit approval.
