# Runbook

## Stages

1. activity catalogue (done): `config/activities.json`, `src/activities.ts`, `src/mapping.ts`;
2. DonationAlerts OAuth + poller, cooldowns, queue, RCON client, SQLite history;
3. pinned ReHLDS image + YaPB + `donation_events` Pawn plugin;
4. end-to-end: real 50 RUB donation -> activity in game -> row in DB;
5. stream: ffmpeg -> private YouTube RTMP;
6. VPS, backups, health checks.

## Local smoke run (no server, no money)

```powershell
$env:DA_MOCK='1'; $env:DB_PATH='data/smoke.db'
npm run fake-donation -- --amount 49  --user Skupoy   # rejected, below_minimum
npm run fake-donation -- --amount 120 --user Vasya    # amx_de bot_rain extraBots=6 maxBots=24
$env:POLL_ONCE='1'; npm start
node -e "import('./src/db.ts').then(m => { const s = new m.Store('data/smoke.db'); console.log(s.recent()); s.close(); })"
```

Expected log lines: `donation.rejected`, `rcon.dry_run`, `donation.applied`, `poll.done`.
A second pass with the same DB must report `cursor` equal to the last id and process nothing.

## Connecting the real account

1. register an application in DonationAlerts, redirect URI `http://127.0.0.1:4318/oauth/callback`;
2. put `DA_CLIENT_ID` / `DA_CLIENT_SECRET` into `.env` (never into git);
3. `npm run oauth-login`, open the printed URL, approve, tokens land in `data/da-token.json`;
4. set `DA_MOCK=0`, `npm start`: access tokens are refreshed five minutes before expiry;
5. if the app is rejected or scopes are missing, the API answers 401 and the poll logs
   `poll.error` — nothing is applied to the game.

## Changing a price

1. edit `price` in `config/activities.json` (keep prices unique and >= `minAmount`);
2. `npm test` — the catalogue test asserts 10 activities, unique prices and sorted order;
3. restart the control API. The Pawn plugin does not care about prices.

## Adding an activity

1. `config/activities.json`: unique `code`, `price`, `duration`, `rounds: 1` or `null`,
   `params` for the effect arguments;
2. plugin: write the handler and call `RegisterDonationEffect("<code>", handler)`;
3. `npm test`, rebuild the image, check `amx_de codes` lists the new code;
4. if the plugin does not know the code, the API disables it on startup instead of
   failing mid-stream — that mismatch is visible in the logs on purpose.

## Stage 3: the game image

```powershell
./infra/update-checksums.ps1          # official GitHub assets -> infra/checksums.env (SHA256)
# pin the resolved tags in infra/components.json when it says "pin this tag"
docker buildx build --build-arg-file infra/checksums.env -t cs16-hlds:local .
./infra/verify-image.ps1              # must pass before the image is allowed near a stream
docker compose -f infra/docker-compose.yml up -d hlds
docker logs -f cs16-youtube-hlds-1
```

Expected in the log: Metamod loaded, `yapb_mm_i386.so` loaded, `donation_events loaded, API 1,
10 activities`. Then from the host:

```powershell
node -e "import('./src/rcon.ts').then(async m => console.log(await m.execOnce({host:'127.0.0.1',port:27015,password:process.env.RCON_PASSWORD},'amx_de codes')))"
```

Acceptance for stage 3: `amx_de codes` lists the 10 codes, `amx_de knives_only` makes the bots
drop their weapons at the next round start, `amx_de map_change maps=de_dust2` changes the map.

Known unknowns to settle on the first real build (each one fails loudly, none fails silently):
archive layout inside the ReHLDS/ReGameDLL/Metamod-R/YaPB zips, exact YaPB cvar names
(`yb_quota` / `yb_difficulty` are tried first, PodBot names second), and the Pawn compile itself.

### Findings from the first real build (2026-10-25)

- `update-checksums.ps1` pinned: ReHLDS 3.15.0.896, ReGameDLL 5.30.0.814, Metamod-R 1.3.0.149,
  AMX Mod X 1.10.0.5487, YaPB 4.4.957 (`yapb-4.4.957-linux.tar.xz`).
- `amxxpc` is a 32-bit binary that `dlopen`s `amxxpc32.so` from the current directory: compile
  from `addons/amxmodx/scripting` and make sure `libc6-i386` is installed. The plugin compiles.
- YaPB ships `addons/yapb/bin/yapb.so`; the archive already mirrors `cstrike/`, so it unpacks over it.
  Its cvars are confirmed from `conf/yapb.cfg`: `yb_quota`, `yb_quota_mode`, `yb_difficulty`.
- Bots play 10 vs 10: `yb_quota 20` and `yb_autovacate 0`, because the stream camera is a real
  connection and vacating a bot for it would leave 10 vs 9. `MAXPLAYERS=22` (20 bots + camera +
  one spare) or the camera cannot join at all.
- Bot chat and radio are off (`yb_radio_mode 0`, `yb_chat 0`, `yb_chat_percent 0`,
  `yb_display_welcome_text 0`): on a stream it is noise over the picture, and the watchdog log is
  kept alive by the `stream_cam` heartbeat instead.
- Metamod-R reads the game DLL from `addons/metamod/config.ini` (`gamedll dlls/cs.so`), not from
  `liblist.gam`, once `liblist.gam` points at Metamod itself.
- **Resolved: ReHLDS 3.15 + current depot.** `engine_i486.so: undefined symbol:
  SteamGameServer_Init` — Valve bumped the Steamworks SDK and the shipped `steamclient.so`
  stopped exporting that symbol. Valve still serves the pre-25th-anniversary build as the
  `steam_legacy` branch: the build pins app 90 depot 4 manifest `8690279432129063737`
  (`STEAM_LEGACY_MANIFEST`) and lays those engine libraries *over* the chosen engine set,
  keeping ReHLDS' own `engine_i486.so`. ReHLDS' bundled `proxy.so` dies with
  `Unable to initialize Steam` against the current steamclient, so the legacy helper
  libraries must win. `WITH_REHLDS` defaults to 1 and the stack boots (verified live).
- **GoldSrc rcon is not the Source binary protocol.** Packets with int32 size/id/type are
  silently ignored (rcon login timeouts). The real wire format is text:
  `challenge rcon` -> `challenge rcon <n>`, then `rcon <n> "<password>" <command>`, answered
  with `'l' + output`. `src/rcon.ts` implements that, and `amx_de codes` on the live server
  returned all 10 codes.
- Metamod-R still needs ReHLDS: with the stock engine it reports `Couldn't get DLL API from !`,
  so `WITH_REGAMEDLL=1` stays off until ReGameDLL is verified separately.
- ReHLDS build order matters: HLDS -> ReHLDS engine set -> legacy libraries (skipping
  `engine_i486.so`). Copying the legacy set *before* ReHLDS brings back its bundled
  `proxy.so` and the engine dies with `Unable to initialize Steam`. Related: the engine
  dlopen()s `$HLDS/.steam/sdk32/steamclient.so` before Steam init, so the build also copies
  the legacy `libsteam_api.so` there — without it the first boot fails and `hlds_run`
  silently restarts once.
- Verified on the rebuilt image: `plugin.contract_ok` (10 activities), a 100 RUB mock
  donation queued `awp_only`, and the plugin reported `awp_only: 8 bots rearmed with AWP`
  at the next round start.
- `verify-image.ps1` scans with `--ignore-unfixed`: 59 HIGH/CRITICAL findings in the Debian
  base layer have no fix for bookworm (util-linux, zlib), so they cannot be patched here.
  A finding *with* a fix still fails the gate, because that would mean a skipped update.

## Streaming

`npm run stream -- --print` shows the ffmpeg command without running it (the key is masked).
The supervisor restarts ffmpeg with exponential backoff (1 s, 2 s, 4 s ... capped at 30 s),
gives up after 10 consecutive restarts, and logs `stream.started`, `stream.exited`,
`stream.restart_in`, `stream.gave_up`, `stream.progress` (frame/fps/bitrate).

Verification without a key: `STREAM_OUTPUT=data/smoke.flv`, `STREAM_SOURCE=test`,
`npm run stream -- --duration 10` must exit 0 and leave a playable file.

Open question for the live stream: the game server is headless, so something has to render the
game. Either a CS 1.6 client on the streaming machine (desktop capture of its window) or a
headless client on Xvfb. Until that is decided the pipeline is verified with the `test` source.

## Autonomous capture (infra/stream)

Proven in the container (Debian trixie, i386 runtime, Xvfb + Mesa llvmpipe + ffmpeg):

- Xvfb starts and `ffmpeg -f x11grab` reads from `:99`; a 10 s grab produced a valid
  1280x720@30 H.264 file, so the capture path is fine;
- the engine (`xash3d` loader + `libxash.so`) renders: with `+map de_dust2` the frame is a real
  3D view (mean luma 38.9), so GL/llvmpipe work on the CPU;
- CS16Client's `cstrike/cl_dlls/client.so` loads under trixie (glibc 2.41). Valve's own
  `client.so` cannot: it needs `SteamInternal_ContextInit` from a Steam session;
- the HLDS engine libraries (`libsteam_api.so`) must **not** be on `LD_LIBRARY_PATH`: they shadow
  the system `libgcc_s.so.1` and the loader then fails with `GCC_7.0.0 not found`;
- the client **does** join and spectate. Verified from the server side (`status` lists
  `[Xash3D]StreamCam`, `STEAM_ID_LAN`) and from the picture (scoreboard and spectator overlay).

Two server settings are mandatory for a non-Steam client, and both are easy to get wrong:

- `-insecure` on the HLDS command line. Without it the server connects to Steam, reports
  `... secure ...` in `version` and answers every join with `STEAM validation rejected`.
  With it: `VAC secure mode disabled`, `version ... insecure`.
- `sv_lan 1` **in server.cfg**, not on the command line: the value is read when the server object
  is created (before `+map`), while `server.cfg` is executed afterwards, so `+sv_lan` is always
  overwritten. `infra/entrypoint.sh` patches the file at start-up like it does with
  `rcon_password`.

Joining: solved with a config file, no GUI automation.

- `+connect <addr>`, `-connect <addr>` and a `connect` line in `config.cfg` are silently ignored:
  Xash3D queues `+`-commands and the auto-executed config during `Host_Init`, which is **before**
  `CL_Init`, so the command runs while the network stack does not exist yet and nothing happens.
  That is why typing the same command into the console (after init) always worked.
- `wait` is a real Cbuf command: it splits the command buffer and resumes the remainder on a later
  frame. A chain of waits therefore defers `connect` until the client is up.
  `stream-entrypoint.sh` generates `cstrike/userconfig.cfg` with 400 × `wait`, then
  `connect <addr>`, 200 × `wait`, `jointeam 6`, 60 × `wait`, `spec_mode 6`.
- `userconfig.cfg` and not `config.cfg`: the engine rewrites `config.cfg` on exit, so anything kept
  there disappears after the first shutdown; `userconfig.cfg` is executed at start-up and left
  alone.
- Verified: the client appears in the server's `status` as `[Xash3D]StreamCam  STEAM_ID_LAN` and
  the captured frame is the game (mean luma 41.7, versus 59.7 for the main menu).

A dead end worth recording, because it cost a lot of time: driving the client through its GUI
(clicking the main-menu "Console" item with xdotool, typing `connect`, OCR to verify) does work but
is not deterministic — the menu item moves between runs, VGUI dialogs swallow input, and the
console eats the first keystroke. All of that was removed once the `wait` chain worked.

### Three traps in the capture container

1. **`connect` needs an IP, not a host name.** GoldSrc does no DNS lookup inside `connect`, so
   `connect srv:27015` fails silently while `connect 172.18.0.2:27015` works. The entrypoint
   resolves `SERVER_ADDR` with `getent` before writing the config.
2. **Secrets in the shared volume block the copy.** The server volume also holds files the
   capture user must not read: `server.cfg` is `0600` (it carries `rcon_password`) and the server
   writes `0600` logs. A plain `cp -a` of `cstrike/` therefore fails with "Permission denied".
   The copy runs through `tar --ignore-failed-read --exclude=logs --exclude=server.cfg ...`.
3. **An entrypoint stored in a volume is frozen.** `/hlds` is a named volume in compose, and a
   volume is seeded from the image only once. With `ENTRYPOINT ["/hlds/entrypoint.sh"]` the
   container kept running the script from the *first* image build, so later fixes (like
   `-insecure`) never took effect and the client was rejected with `STEAM validation rejected`.
   The entrypoint now lives in `/usr/local/bin` — outside every volume.

### Reconnect behaviour and the frozen-picture case

The client has no scripting interface, so the watchdog reads the engine's own output. With `-dev`
the engine prints `Connecting to ... (retry #N)`, `Server connection timed out` and
`execing mainui.cfg` to stdout, which is redirected to `/tmp/xash.log`. After two strikes
(15 s apart) `watchdog.sh` kills the engine and the client loop restarts it, which rejoins through
`userconfig.cfg`. Retries 1–4 are ignored on purpose: a server that is still booting makes the
client retry a few times during a normal start.

Matching is case-insensitive, and it includes `Server issued disconnect` and
`has been idle for too long`: that is what the engine printed when it kicked the camera for being
idle, and the old capitalised `Disconnected` pattern missed it, so the client stayed in its menu
and the stream showed a static picture while `ffmpeg` happily kept encoding.

The log also has to grow. Bot chat used to be what kept it alive; `yb_radio_mode 0` in
`infra/server.cfg` silenced it, so `stream_cam` now prints its own heartbeat into the client
console (`[stcam] target=... hp=... pov=...`, every `stcam_heartbeat` = 60 s). `LOG_STALE_SEC`
(120 s) of silence still means "the client is not on the server".
"the client is not on the server" even when no disconnect line was printed at all.

A second failure looks identical from outside: the client is on the server, the log grows, but the
picture does not change (the team menu, or the camera on a dead body). Every `MOTION_SEC` the
watchdog grabs three seconds of the Xvfb display through `freezedetect`; four static samples in a
row (~1 min) restart the client, while one or two are normal between rounds.

`watchdog.sh` also writes `/game/.stream/runtime.json` every `CHECK_SEC`:
`{"ts":…,"xashAlive":true,"logAgeSec":3,"frozen":false,"restarts":0}`. The admin panel turns this
into one verdict - `live`, `frozen`, `stalled` (heartbeat older than 45 s) or `offline` - and shows
the log silence and the restart count.

Verified by stopping and starting the game server: the client dropped, the engine was restarted,
and after the server came back the log showed `[Xash3D]StreamCam ... entered the game` and
`joined team "SPECTATOR"` without any human action. The idle kick was verified by watching
`Game_idle_kick` disappear from the server log after `mp_autokick 0`.

A frame-brightness watchdog was tried first and thrown away: mean luma cannot separate the main
menu (~60) from a bright map (de_dust2 at 640x480 is ~120). `freezedetect` compares frames instead
of absolute brightness, so it works in both.

Camera director check: `amx_stcam status` prints
`stream_cam status: enabled=1 interval=25.0 mode=1 spectator=<name> target=<name> candidates=<n> pov=<0|1> dwell=12.0 hp=<n> active=<mode>`,
and the server log gets one `camera target <bot> (<reason>, score ...)` line per switch. `mode=1`
is chase locked (third person), `active` is what the client has right now (`4` while it is in
first person after the followed bot fired), and `candidates` must be 20 on a 10 vs 10 server.

Why third person by default: a director that re-picked the busiest bot every 8 s looked like the
camera teleporting around the map, and the open-source client draws no view model for a
spectator, so first person had no weapon at all. The camera holds one bot until it dies, stops
moving or the hold time is up, shows it in third person, and cuts to first person for
`stcam_pov_sec` when that bot shoots or kills. In first person `WeaponList` + `CurWeapon` give
the client a weapon to draw, and `Health` + `ArmorValue` + one HUD line give viewers real
numbers instead of an empty health bar.

### Gate

`infra/verify-stream.ps1 -SmokeTest` checks the image statically (binaries, resolved libraries,
x11grab support, no setuid files, payload inventory) and then runs a real game server next to the
capture container for up to 7 minutes. It fails unless the server logs
`StreamCam ... entered the game` **and** the recording contains frames and is not black. The join
is judged by the server, not by the picture, because brightness is not a reliable discriminator.




## Donation handling rules

- amount < 50 RUB or currency != RUB -> rejected, logged, nothing happens;
- amount buys the most expensive activity it can afford; leftover is not banked;
- one activity per round, donations during an active activity wait in FIFO queue;
- per-donor cooldown 60 s, map change at most once per 10 minutes.

## Security rules

- the donor nickname is untrusted input: whitelist `[A-Za-z0-9 _.-]`, 16 chars, translit,
  never interpolate it into an RCON command line without validation (newline = command
  injection);
- keys and tokens only in `.env` / vault, never in git, logs or test fixtures;
- the game image is built from pinned official releases (ReHLDS, ReGameDLL_CS, Metamod-R,
  AMX Mod X 1.10.0.5487, YaPB) with SHA256 checks, then scanned (trivy, ClamAV) and
  verified against a whitelist of expected binaries; no community `hlds` images.

## Before a stream

- `npm test` green, `amx_de codes` matches the catalogue;
- one test donation of 50 RUB -> bot nickname changes, row appears in the DB;
- RCON password rotated if the server was exposed, `.env` not world readable.
## Local testing: watch the stream, drive the panel

Everything below runs on one machine, without a stream key, without going live and without spending
a donation.

### 1. The stream in a browser

The capture container pushes RTMP exactly like it does to YouTube; only the target changes.

```powershell
./infra/compose.ps1 --profile local-view up -d mediamtx hlds
./infra/compose.ps1 run --rm -e STREAM_OUTPUT=rtmp://mediamtx:1935/live/test stream
./infra/compose.ps1 logs -f mediamtx      # expect: is publishing to path 'live/test'
```

Use `compose.ps1` (or `docker compose --env-file .env -f infra/docker-compose.yml ...`): the compose
file lives in `infra/`, so compose looks for the environment file there and refuses to start with
`RCON_PASSWORD is missing a value` otherwise.

Then open `http://localhost:8889/live/test?muted=false` (WebRTC) or `http://localhost:8888/live/test`
(HLS). If WebRTC shows nothing, the UDP port 8189 is blocked — HLS is the fallback.

`STREAM_OUTPUT` resolves the container by scheme: `rtmp(s)://` → FLV, `tcp://`, `udp://`, `srt://` →
MPEG-TS (TCP also gets `-listen 1`, so a player connects to us), anything else → a Matroska file. A
file target still needs `STREAM_RECORD_SEC` to stop by itself.

### 2. One page: the stream and the panel

```powershell
./infra/compose.ps1 up -d hlds control-api
./infra/compose.ps1 run -d --name cs16-panel-stream -e STREAM_OUTPUT=rtmp://mediamtx:1935/live/test stream
# open http://127.0.0.1:8085 (or ADMIN_PORT) and paste ADMIN_TOKEN
```

The page holds everything: the picture (HLS through hls.js, with sound) on top, then the activity
cards with a **Run** button, the live `active`/`queued` state from the plugin, the debug donation
form, the history of what the panel sent, the donations, and the encoder layout. No second URL.

Two things that made the player hang forever, both fixed and worth knowing:

- `docker compose run` does not apply `restart:` — a push started that way stays down after a Docker
  or machine restart. For a preview that survives, put `STREAM_OUTPUT=rtmp://mediamtx:1935/live/test`
  in `.env` and use `./infra/compose.ps1 --profile local-view up -d mediamtx stream`.
- The software OpenGL renderer (llvmpipe) used every core it could see: measured **625% CPU for the
  client alone**, which starved the encoder until HLS segments arrived too late and the browser
  spinner never stopped. `LP_NUM_THREADS=2` brings the whole capture container to ~200% on a 12-core
  machine and keeps 30 fps at 960x720. Do not remove it on a small VPS.
- The game client draws its own "SELECT TEAM" panel over the picture and nothing closes it: the
  console commands `jointeam`/`menuselect`/`cancelselect` do nothing, and commands sent by the server
  are refused by the client (`Could not execute privileged command`, visible in `/tmp/xash.log`).
  Only a key press works, so `stream-entrypoint.sh` runs `xdotool key 6` (SPECTATE) for the first
  minute and once a minute after that. Verified on a frame: the panel is gone and the stream shows
  the followed bot's view.

- **Run** sends `amx_de <code>` with the parameters shown in the row (edit them under `params`), so a
  run needs no donation and ignores cooldowns. The plugin queues it and the round that starts next
  plays it; the card shows `queued` until then.
- **Debug donation** injects a fake donation through the same pipeline as a real one and prints the
  verdict with the exact command.
- **Stop everything** sends `amx_de clear`.
- Every command the panel sends is stored in the `admin_actions` table (kind, code, params, exact
  RCON line, reply) and listed on the page: that is the audit trail for "who started this round".

If port 8080 is taken, set `ADMIN_PORT` (e.g. `ADMIN_PORT=8085`); the compose file publishes the
panel on loopback only. `STREAM_HLS_PORT` / `STREAM_HLS_PATH` (default 8888 and `live/test`) tell the
page where the hub is; the browser uses its own hostname, so the same page works from a phone in the
LAN as long as the port is published.

Three ffmpeg facts learned the hard way, all encoded in `infra/stream/entrypoint.sh`:

- **never pipe ffmpeg's stderr into the entrypoint** and never use `-progress <file>`: both stall the
  encoder right after the FLV header (2 frames in 10 s, `speed=0.017x`), and the hub then drops the
  idle publisher with `Broken pipe`. stderr goes to `/tmp/ffmpeg.log`, a separate `tail -F` copies it
  to the container log;
- an RTMP server drops a publisher that sends nothing for its read timeout, and our first packet can
  arrive around 11 s on a loaded CPU: the local hub runs with `MTX_READTIMEOUT=60s`;
- the encoder waits for the client's connect line (`Trying to connect with GoldSrc`) plus
  `STREAM_JOIN_SETTLE_SEC`, and it is supervised: a failed attempt is retried, never fatal.

Endpoints (all require `X-Admin-Token`, mutations require `application/json`, body limit 64 KiB):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | catalogue, active activity, last 20 donations, history, stream layout |
| POST | `/api/simulate` | `{amount, username, message?, bypassCooldown?}` — fake donation through the real pipeline |
| POST | `/api/trigger` | `{code, params?, nick?}` — `amx_de <code>` now |
| POST | `/api/activity/<code>` | `{price?, cooldownSec?, globalCooldownSec?, enabled?, params?}` |
| POST | `/api/activity/<code>/reset` | drop the override for one activity |
| POST | `/api/settings` | `{minAmount?, defaultCooldownSec?}` |
| POST | `/api/clear` | `amx_de clear` — round effect, renamed bot, queue |
| POST | `/api/sim-reset` | delete rows with `source = 'sim'` |

Milestone check without the browser:

```powershell
curl -s -H "x-admin-token: $env:ADMIN_TOKEN" http://127.0.0.1:8085/api/state
curl -s -H "x-admin-token: $env:ADMIN_TOKEN" -H "content-type: application/json" `
  -d '{"code":"bot_rain","params":{"extraBots":10}}' http://127.0.0.1:8085/api/trigger

```

Expected: `"status":"applied","activityCode":"meat_round"`, and in the server console
`donation_events queued meat_round`, then `started meat_round` at the next round start.

### 3. What the panel can and cannot change

- **Can, live**: prices, cooldowns, `enabled`, `params`, default cooldown; they go into
  `data/activities.override.json` and are applied in memory at once.
- **Cannot**: `minAmount` above the cheapest price (the catalogue parser refuses it — raise every
  price first), and anything that lives outside the control API: `DA_POLL_SEC`, DonationAlerts keys,
  stream resolution/bitrate, the capture camera. Those stay in `.env` and need a restart, on purpose:
  a panel that restarts the encoder needs the Docker socket, and the Docker socket is root.

### 4. Rules the panel inherits

- simulated donations consume cooldowns unless "bypass cooldown" is ticked, and are tagged `sim`;
- simulated ids are negative, so they never affect the poll cursor for real donations;
- editing a price does not affect `config/activities.json`; `npm test` still asserts the shipped
  catalogue (10 activities, unique prices, sorted order).



## Camera limits of the open-source client (verified 2026-10-26)

In first person the client draws no view model (no hands, no weapon) and no HUD text: the HUD line
from `stream_cam` shows in third person only, and `WeaponList` + `CurWeapon` are accepted without
producing a gun. First person is therefore a clean action cut, not a way to show the weapon; the
gun a viewer sees comes from the third person camera, where the bot model holds it.

`cs_get_user_bpammo` on a knife (weapon id 29) raises "Invalid weapon id" and aborts the rest of
the HUD update, which is why the HUD line disappeared whenever a bot pulled a knife. The plugin now
skips the ammo lookup for weapons that have no ammo type.
