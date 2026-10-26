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

### Reconnect behaviour

The client has no scripting interface, so the watchdog reads the engine's own output. With `-dev`
the engine prints `Connecting to ... (retry #N)`, `Server connection timed out` and
`execing mainui.cfg` to stdout, which is redirected to `/tmp/xash.log`. After two strikes
(30 s apart) `watchdog.sh` kills the engine and the client loop restarts it, which rejoins through
`userconfig.cfg`. Retries 1–4 are ignored on purpose: a server that is still booting makes the
client retry a few times during a normal start.

Verified by stopping and starting the game server: the client dropped, the engine was restarted,
and after the server came back the log showed `[Xash3D]StreamCam ... entered the game` and
`joined team "SPECTATOR"` without any human action.

A frame-brightness watchdog was tried first and thrown away: mean luma cannot separate the main
menu (~60) from a bright map (de_dust2 at 640x480 is ~120).

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
