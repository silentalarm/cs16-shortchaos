# cs16-youtube

CS 1.6 dedicated server with bots, streamed to YouTube. A viewer donation is turned into
an in-game activity: knife round, zombie round, one bot with an M249 against everyone,
map change, and so on. Everything is driven by donations, nobody plays by hand.

Status: stage 3 works end to end on a live server — the control API polls donations (mock or
DonationAlerts), maps them to activities, enforces cooldowns, sends RCON commands and stores
the verdict. Verified on ReHLDS + Metamod-R + AMX Mod X: a 50 RUB donation reached the plugin
in game (`queued 'bot_nick' for the next round`).

## Layout

```
config/activities.json   what a donation buys (prices, durations, cooldowns, params)
src/activities.ts        catalogue schema: loads, validates, fails fast on a bad config
src/mapping.ts           donation amount -> activity, deterministic, no viewer input
src/cooldowns.ts         per donor and per activity rate limits, based on stored facts
src/command.ts           builds the RCON line, sanitizes donor nicknames (injection guard)
src/rcon.ts              minimal RCON client (GoldSrc: `challenge rcon` over UDP) with timeouts
src/donationalerts.ts    OAuth2 (code + refresh) and the donations list endpoint
src/db.ts                SQLite: donation history, dedup by id, polling cursor
src/poller.ts            one polling pass: dedup, map, cooldown, apply, store
src/main.ts              daemon: env, wiring, graceful shutdown, POLL_ONCE mode
scripts/fake-donation.ts appends a fake donation for the mock source
scripts/oauth-login.ts   one-off OAuth helper, writes data/da-token.json
plugins/donation_events/ Pawn plugin: effect registry, one public handler per activity
infra/Dockerfile         game image: HLDS + ReHLDS + ReGameDLL + Metamod-R + AMXX + YaPB
infra/build-hlds.sh      assembles the server, verifies every SHA256, compiles the plugin
infra/update-checksums.ps1 resolves official release assets and writes infra/checksums.env
infra/verify-image.ps1   supply-chain gate: binary whitelist, no suid, trivy scan
infra/docker-compose.yml hlds + control API (shared network namespace)
```

Planned: ffmpeg streaming to YouTube.

## Rules baked into the catalogue

- minimum donation is 50 RUB, non-RUB donations are rejected, never converted;
- an amount buys the most expensive activity it can afford, leftovers are not banked;
- round-based activities last at most one round; `bot_nick` lives until map change;
- `map_change` runs at the next round start and is rate limited to once per 10 minutes;
- `announce` must be printable ASCII: GoldSrc chat cannot render cyrillic;
- codes are stable: the Pawn plugin registers effect handlers by code.

## Commands

```powershell
npm test                                  # node:test, no runtime dependencies
npm run typecheck                         # tsc for src/, test/ and scripts/

npm run fake-donation -- --amount 120 --user Vasya   # mock donation (DA_MOCK=1)
$env:POLL_ONCE='1'; npm start              # one pass, then exit
npm start                                  # daemon, polls every DA_POLL_SEC
npm run oauth-login                        # once per account, writes data/da-token.json
```

Dry run: leave `RCON_PASSWORD` empty and commands are logged instead of sent, so the whole
pipeline can be exercised before the game server exists.

## Building the game image

The image is assembled only from official releases, each pinned by SHA256; there is no
`FROM someone/hlds` anywhere. Docker Desktop / Docker Engine with BuildKit is required.

```powershell
./infra/update-checksums.ps1                     # resolve assets, write infra/checksums.env
./infra/build-image.ps1                          # expands that file into --build-arg
./infra/verify-image.ps1                         # binary whitelist, suid, trivy HIGH/CRITICAL
docker compose -f infra/docker-compose.yml up -d hlds
docker logs -f cs16-youtube-hlds-1               # wait for "donation_events loaded"
```

Then point the control API at it (`RCON_PASSWORD` in `.env`, `npm start`) and check the
contract: the API logs `plugin.contract_ok` when `amx_de codes` matches the catalogue.

## Streaming

`src/stream.ts` builds and supervises the ffmpeg pipeline; `scripts/stream.ts` is the CLI.
The stream key lives only in `.env` and is masked in every log line.

```powershell
npm run stream -- --print          # show the exact ffmpeg command, key masked
npm run stream -- --duration 20    # run for 20 s, then stop (exit code 1 if no frames)
npm run stream                     # push until Ctrl+C, restarts ffmpeg with backoff
```

`STREAM_SOURCE` picks what to capture: `desktop` (Windows `gdigrab`, with
`STREAM_OFFSET_X/Y` to grab the game window region), `x11` (Linux `Xvfb` screen, `STREAM_DISPLAY`)
or `test` (synthetic pattern, no display needed). Setting `STREAM_OUTPUT` records to a local
`.flv` instead of going live, which is how the pipeline is verified without a stream key.

The output is 720p30 H.264 (CBR at `STREAM_BITRATE_KBPS`, keyframe every
`STREAM_KEYFRAME_SEC`) plus a silent AAC track, because YouTube flags video-only streams.

### Vertical canvas for the Shorts feed

`STREAM_ORIENTATION` picks the layout. `vertical` (the default) composes a 720x1280 canvas: the
engine still renders a 4:3 picture (`STREAM_CAPTURE_WIDTH/HEIGHT`, 960x720 by default), ffmpeg
scales it to the canvas width and pads the rest, so `scale=720:540,pad=720:1280:0:140` puts the
game in the upper part and leaves the band below for donation text and for the Shorts UI. Stretching
the game itself to 9:16 would ruin the field of view, which is why the composition is done in ffmpeg.
`horizontal` is the old 16:9 passthrough.

Without a stream key the picture can still be reviewed: `STREAM_OUTPUT=/game/rec.mkv` records
instead of going live, `STREAM_WARMUP_SEC` waits for the spectator client to join, and
`STREAM_RECORD_SEC` stops the recording and exits the container.

The camera is a spectator client, and its mode matters: `STREAM_SPEC_MODE=4` is `OBS_IN_EYE`
(through the followed player's eyes), while `spec_mode 6` is `OBS_MAP_CHASE` — the map overview,
which shows no gameplay at all. A `spec_next` chain every `STREAM_SPEC_SWITCH_SEC` seconds moves
the camera between players, otherwise it stays on one bot forever.

Sound needs three pieces, because a container has no sound card: PulseAudio runs with a null sink,
`/etc/asound.conf` routes ALSA into it (the bundled SDL2 in the Xash3D release has no PulseAudio
backend, only ALSA), and ffmpeg records `cs.monitor`. The client volume is lowered to
`STREAM_GAME_VOLUME` (0.6 by default) — GoldSrc mixes at full scale and the capture measured peaks
at +8 dB, i.e. clipped — and the encoder adds a limiter as a safety net.

### Autonomous capture (no human, no Steam account)

`infra/stream` is a second image that renders the match itself: Xash3D-FWGS (open-source
GoldSrc engine, GPLv3) runs the CS 1.6 client inside a virtual X display, Mesa llvmpipe
rasterises on the CPU and ffmpeg pushes the result to YouTube. Nothing needs a logged-in
Steam client, a GPU or a window manager.

```powershell
./infra/update-checksums.ps1 -Only XASH3D,CS16CLIENT   # pin the two capture assets (keeps the rest)
./infra/build-stream.ps1                               # builds cs16-stream:local
./infra/verify-stream.ps1 -SmokeTest                   # static checks + a real server, confirms the join
docker compose -f infra/docker-compose.yml up -d       # hlds + control-api + stream
```

Two upstream facts shape this image:

- the engine must be the **i386** build, because HLDS content ships 32-bit `cl_dlls/client.so`
  and `dlls/mp.so` and the amd64 engine only loads `*_amd64.so` twins that do not exist there;
- Valve's own `client.so` needs a Steam session, so the client library is **CS16Client**
  (FWGS, open source). Its current build needs glibc 2.38+, which is why the capture image is
  based on `debian:trixie-slim` while the game server stays on bookworm.

The client joins on its own: `stream-entrypoint.sh` writes `cstrike/userconfig.cfg` with a chain of
`wait` commands around `connect`. `+connect` on the command line does not work — Xash3D runs those
commands during `Host_Init`, before the network client exists, and silently drops them. See
`docs/runbook.md` for the full explanation.

## Adding an activity

1. append an entry to `config/activities.json` (unique `code`, price >= 50, new price
   keeps mapping unambiguous);
2. add the Pawn handler and register it under the same `code`;
3. run `npm test` and rebuild the image.

No changes in the control API or the dashboard are required.
