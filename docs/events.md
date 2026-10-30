# The 2025-10 event set

> **Superseded (2026-10).** The set below is the record of the five-event deal. The plan that replaces
> it — 6 kept codes, 17 removed, 44 new in nine systems, with assets and the order of work — lives in
> [`docs/activities/`](activities/README.md). Read that first; this file stays as history and as the
> list of ideas that were rejected and why.

The stream sells **five events, one price, one length** and runs **one accumulation bar**. This file is
the record of that decision: it is written down so a later session does not have to re-derive it from
chat history. Code lives in `config/activities.json`, `plugins/donation_events/donation_events.sma`
and `src/mapping.ts`.

## The deal

1. **50 RUB = one event.** Every enabled entry is priced at `minAmount`, so a donation of 150 RUB buys
   three steps and the steps of one code are merged into one longer run (see `planActivities`).
2. **15 seconds.** Every event is `duration: "seconds"`, `seconds: 15`, and carries the same clock in
   `params.seconds` because the plugin reads the length from the RCON line.
3. **One event in the frame.** Each handler calls `BeginEvent()`, which drops whatever was running
   (`ResetEventState` + `StopAllEffectTimers` + `CleanupActive`). Ice under a time stop, a freeze
   during a meteor shower and two cameras fighting for the same bot is not a show.
4. **The camera is part of the product.** Any event with a "hero" is supposed to cut to that bot.
5. **One bar.** Not one per event: a single community goal on screen (`boss_finale`, still to build).

## On sale

| Code | Reference | What happens | Reset |
|---|---|---|---|
| `glass_cannon` | Doom/Quake berserk | one bot: **1000 HP** (the health it had is remembered and put back on the clock), M249, infinite ammo without reload (clip refilled 5×/s), red glow; the role moves to another bot when it dies | clock + health restored + glow cleared |
| `meteor_shower` | PUBG red zone | **3 strikes** of `TE_EXPLOSION` + damage sphere every **0.07 s** (43 explosions a second), **2 dmg** each, r=320 - a barrage that tickles instead of one that clears the map | task removed by the clock |
| `red_light` | Squid Game "red light, green light" | 1.5 s all frozen / 2 s all moving, repeating, opens on RED; **the broadcast cues** are `infra/sounds/red.mp3` and `green.mp3`, played per phase by the capture container (`params.stock: 0` mutes the stock alarm/chime) | everyone thawed |
| `lightsaber_duel` | Star Wars | knives only, 25 HP, speed ×1.4, glow by team (T orange, CT blue); **the rule holds for the whole event** - a weapon in hand, picked up from the ground or re-armed by csdm_lite on respawn is taken away (`CurWeapon` + `Ham_Touch` on `weaponbox` + respawn hook); **30 s, and the opera bed is the only audio** (`params.stock: 0` + `params.onlyMusic`) | `ResetBotSpeed` + `ClearGlow` |
| `one_bullet` | John Wick | one round in the clip, none in reserve, then knives | nothing to restore |

Rejected and not to be re-proposed without a new reason: `crowd_pile` (froze the capture client twice),
`sniper_moment` (no camera cut, so the paid shots happened off screen and read as "nothing happened"),
`ice_floor` (zero friction did not visibly change how the bots move), `bet_on_bot` (no payout),
`flip_sides`, `invisible_bots`, `duel_pairs`, `friendly_fire`, `traitor`.

## The one bar — `boss_finale` (planned, not built)

Threshold **1500 RUB** (30 steps), auto-lowered by 10% after 24 h without progress, floor 1000 RUB.
The reward is a **scripted 15 second scene**, not a stack of everything at once:

- 0-2 s - everyone frozen, camera on the frag leader, `FINALE` in the panel;
- 2-4 s - that bot gets 3000 HP, an M249 with infinite ammo and a red glow; the rest get knives and 50 HP;
- 4-13 s - the beating, from the camera;
- 13-15 s - a final explosion, the winner's name in the panel, the bar resets and a new cycle starts.

Progress is counted from stored donations (like `cooldowns.ts`), so no new table is needed.

## Choosing an event in chat

All eight cost the same, so the price cannot tell them apart. The donation message is read as a hint
(`EVENT_KEYWORDS` in `src/mapping.ts`): `pile`, `sniper`/`awp`, `cannon`/`glass`, `ice`, `meteor`,
`light`/`redlight`, `saber`/`jedi`, `bullet`. The first word that names an enabled event buys that
event for every step paid for; anything else falls back to the roll, which keeps the tier a small
gamble and needs no UI.

## Ideas kept for later (adaptable to this build)
## Several activities at once

A 1000 RUB donation buys 20 units and the roll can land on five different events - all of them run now,
at the same time:

- `BeginEvent()` no longer resets the world: each effect owns its state and its clock (`StartEffectTimer`
  is per code), so starting one cannot cancel the others;
- `FinishEffect()` calls `EndEffectState(code)`, which gives back only what that effect took: the cannon
  restores its own bot's health, the duel restores speed and clears the glows it put on everyone, the
  freeze thaws and drops its phase tasks. Codes without per-effect state keep the old global reset;
- the round boundary, `amx_de clear` and `plugin_end` still run the full `CleanupActive()`;
- `status` reports `active=<code>`; when the last-started effect ends, the plugin reports the next one
  whose clock is still armed (`LiveEffectCode`), so `active=none` really means "the frame is empty".

Sound follows the same rule: **one bed per donation**, taken from the first effect that has one, with
the clock of the *longest* effect, and **one spoken line** naming everything that dropped - six
announcements inside one second talked over each other. On top of that `src/main.ts` polls
`amx_de status` twice a second and cuts the bed the moment the game reports nothing (`voice.bed_cut`):
the round end silences effects that no clock of ours knows about, and the music has to follow.



A donation buys its own event, and the money also fills a shared meter toward a forced `chaos_core`
effect. `src/chaos-meter.ts` holds the arithmetic (`CHAOS_THRESHOLD = 1000`), `src/main.ts` owns the
wiring:

- the meter is **rebuilt from the `applied` rows**, not from a callback: `chaos.total` and the cursor
  `(chaos.last_at, chaos.last_id)` live in the SQLite `state` table, so a restart or a queue drain
  counts each donation exactly once. The cursor is a pair because simulated donations carry negative
  ids (`-Date.now()`) and `received_at` can repeat inside one second;
- on a database that has never seen the meter it starts at the newest applied row, so the whole
  donation history does not fire a burst on the first tick;
- every full thousand sends `amx_chaos force` (one per burst) and speaks `Копилка полна. ХАОС!`; the
  overshoot stays on the bar (`1050 -> one burst + 50`), which is why `addToChaos` returns a remainder;
- the bar is its own drawtext line (`chaos.txt`, amber `0xE0A856`, `STREAM_UI_SIZE_CHAOS`), above the
  donation line: `ХАОС █░░░░░░░░░ 150/1000 RUB`. `chaosFill()` rounds **down**, so the bar never shows a
  run the money has not paid for.

## What a donation shows and says

Two lines on the strip, because one could not hold a batch:

- `LAST: Вася 500 RUB` (plus the viewer's message when it fits) - who paid and how much;
- `1 ПУЛЯ, МЕТЕОР, ДУЭЛЬ, СВЕТОФОР, ПУШКА` - everything the money bought. The list uses
  `params.short` (the catalogue's one-word labels) and drops the `ВЫПАЛО:` prefix when five names need
  the room; `LAST_LINE_CHARS = 41` is the measured fit at fontsize 26 and is the same number as
  `PANEL_LIMITS.last`, so neither side cuts what the other wrote. The full `say` line is still what the
  voice speaks, and the voice stops at three names plus "и другие": reading five out loud is a fifteen
  second monologue over the next event.


GunGame / Arms Race ladder, surf and bhop cvars, Doom BFG wave, Mortal Kombat fatality freeze, Predator
cloak (weaker than it sounds - see `invisible_bots` above), an isekai truck (needs a model),
Death Note "heart attack" (`Ham_TakeDamage` only), One Piece / Naruto clones (needs models).

Models and sounds are worth it only when the model *is* the effect (truck, meteor); everything else is
cheaper as bot state. Custom assets belong in `plugin_precache()`.

## Announcements: a sound, and a voice

Every event announces itself twice, and both ways are outside the game client on purpose.

1. **In-game sound** (`AnnounceEventSound` in `BeginEvent`): stock CS 1.6 files, precached, played on
   every client - `glass_cannon` gets `ambience/lv_jubilee.wav`, `meteor_shower`
   `ambience/thunder_clap.wav`, `one_bullet` `weapons/awp1.wav`. Two events switch this channel off
   with `params.stock: 0`:
   - `red_light` - its opener (`ambience/lv_neon.wav`, a neon hum) together with the per-phase alarm and
     chime, because the broadcast plays `infra/sounds/red.mp3` and `green.mp3` instead;
   - `lightsaber_duel` - its opener is `ambience/Opera.wav`, **72.7 s of opera**: the game started it at
     second 0 and it kept singing for a minute after the event was over. The stream now plays the same
     file itself as the bed and cuts it with the event clock, and the swing cue at the start is stock
     too, so it is off as well. `params.onlyMusic: true` drops the spoken line, so music is all there is.
2. **Spoken / music** (`src/voice.ts` + `infra/stream/voice.sh`): the control API writes a small
   request file into `<overlay>/voice`, the capture container synthesises it with **espeak-ng** and
   plays it into the same PulseAudio null sink ffmpeg records. That is why speech needs no game asset:
   a GoldSrc sound would have to be precached and shipped to the client, while the broadcast audio
   path is already ours.
   - `params.say` - Russian text spoken on every application of the event (never sent to RCON: it is
     dropped by `command.ts`, because RCON cannot carry spaces or Cyrillic);
   - `params.sound` - absolute path **inside the capture container** to a ready-made one-shot cue; it
     replaces `say`. A cue is its own channel in the player (`/tmp/voice-cue.pid`): it plays in the
     background and the next cue replaces it, so a phase sound never drifts behind the game clock.
   - `params.music` - absolute path to a real **bed** (a track that plays for the whole event); without
     it the bed is the activity code, resolved by the player as `<overlay>/music/<code>.wav` first and
     `/usr/share/cs16/music/<code>.wav` second. Never sent to RCON either.

## Event music

Every application of an event starts a bed and stops it when the event clock runs out - that is the
whole contract, and it is enforced in two places:

1. `src/voice.ts` writes `music=<code>` and `seconds=<activity.seconds>` into the request.
   The number is `params.seconds`, not the top-level field: `params.seconds` is what RCON carries, so it
   is what the plugin really runs on, and the panel can patch it for a single run (`/api/trigger`). A bed
   that followed the catalogue while the game followed the patch outlived its event - a 15-second duel
   under a 30-second opera.
2. `infra/stream/voice.sh` starts `paplay` in the background, remembers its pid, and a subshell sleeps
   exactly `seconds` and then kills it, unless a newer request already replaced it. So a 15-second
   event can never leave a three-minute track running into the next donation, and a new event kills the
   previous bed (`music stopped` in the log). The panel's Stop button writes `stop=1`, which kills the
   bed immediately.

Why the beds are synthesised: `src/music.ts` holds note tables (chiptune: square/saw/triangle lead, a
triangle bass and a noise drum channel) and renders a 15-second mono 16-bit WAV at 22 050 Hz.
`infra/music/generate.ts` is executed by a `node:24-bookworm-slim` build stage of
`infra/stream/Dockerfile`, so the repository keeps no audio binaries while every image ships music.
A real track replaces any bed with no rebuild: put `<code>.wav` into `<overlay>/music/`.
`params.music` points at any file inside the capture container: `lightsaber_duel` uses the game's own
`/game/cstrike/sound/ambience/Opera.wav` (72.7 s) and the clock cuts it at the event's 30 s - the only way
to keep a stock track from outliving the event it belongs to.

Two operational notes:

- a **phase** event has no bed: `src/main.ts` returns right after scheduling the phase cues, so the
  cue *is* the soundtrack of the event (a 15-second chiptune under a cue every 1.5 s was clutter).
  Every other event still starts its bed and its announcement as described above.

- requests older than `MAX_AGE_SEC` (30 s) are skipped by the player. The overlay volume is read-only
  in the capture container, so played requests cannot be deleted and their markers live in `/tmp`,
  which a restart clears; without the age check a restart would replay the last two minutes of
  announcements and beds.
- `docker cp` a new `voice.sh` into a **running** container does not work: the shell reads the script
  as it runs. Change the file, rebuild the image, `up -d --force-recreate stream`.
   - voices: `VOICES` in `src/voice.ts` (`ru+m3`, `ru+m4`, `ru+f3`, `ru+m7`, `en+m3`, `en+f4`), picked at
     random per announcement, which is what "different voices" needs.
   - **the overlay volume is mounted read-only in the capture container**, so `rm` after playing does
     not work. "Played once" is enforced with a marker per request (`/tmp/voice-seen/<name>`), and the
     control API prunes requests older than `VOICE_MAX_AGE_MS` (120 s). Without both, one request
     repeated every ~1.7 s forever - that actually happened with a smoke-test line.
   - an event whose sound belongs to a **phase** (`red_light`) uses `params.soundRed` and
     `params.soundGreen`: the API schedules one file request per phase (RED at 0 s, GREEN at 1.5 s,
     then the pair every 3.5 s) and `params.stock: 0` silences the plugin's stock channel - opener,
     alarm and chime - so two sources never overlap. The catalogue points both at
     `/usr/share/cs16/sounds/{red,green}.wav`, which `infra/stream/Dockerfile` renders from the MP3s in
     `infra/sounds` with ffmpeg: `paplay` plays what libsndfile decodes, and a converted WAV always
     plays. Each file is **peak-normalised to -0.9 dBFS** at build time, because the game mix is loud
     and the pair arrived 2 dB apart - a cue a couple of dB under its twin is a cue nobody hears.
     `node scripts/wav-levels.ts <file.wav>` prints the level per 100 ms, which is how that was
     measured. Replacing a cue is a file swap in `infra/sounds` plus a rebuild of the stream image;
     without the two parameters the stock cues stay. `stock` is read **once**, when the event starts,
     into `g_redStockCues`: AMXX clears the parameter table as soon as the RCON command handler
     returns, and the phase timers fire 1.5 s and 3.5 s later, so reading it there answered with the
     default 1 and the stock chime and alarm came back after the first cue.
   - checks: `docker logs cs16-youtube-stream-1 | Select-String "\[voice\]"` shows `said [voice]: text`.

YouTube chat is **not** wired yet: reading the live chat needs the YouTube Data API (`YOUTUBE_API_KEY`
and the live video id). The TTS side is ready for it - `src/voice.ts` already has `botSpeech()`, which
prefixes a bot name and picks a random voice.


**The capture client is the weakest piece of the stack, and it renders on llvmpipe (software OpenGL).**

- **`crowd_pile` is gone for good.** Its first shape (19 bots in a ring of radius 56, re-armed every
  1.5 s) froze the capture client outright: its log stopped mid-line, `/game/.stream/runtime.json`
  showed `frozen: true`, and the picture died while the game server kept running normally. A milder
  shape (6 bots, ring of 140, one re-arm at 7 s) was tried and still broke the stream, so the code,
  the catalogue entry and the chat keyword were deleted rather than retuned.
- The watchdog then did its job and killed the client - and the relaunched client came back on the
  **main menu** (`execing mainui.cfg`), so the stream kept publishing a menu. Restarting the whole
  `stream` container is what restores the picture.
- The rule that follows: **the capture client cannot render many models in one frame area at all.**
  Any future event that clusters bots inherits this limit; do not retune a cluster effect, replace it.
- `docker stats` sits at ~220-230% CPU for the stream container with the picture live; that is
  normal, not a symptom. The symptom is `logAgeSec` growing and `frozen: true`.


`FL_FROZEN` on YaPB bots (does the bot AI or the engine clear it?), the clip refill without a reload
animation, glow on the CS16Client, `set_user_origin` into a ring without stuck bots, `Ham_TraceAttack`
looking like a shot in the picture, and `mp_friendlyfire` is *not* used any more. One dependency is
still missing: the `boss_finale` aggregator. The camera cut it needed is now built -
`amx_stcam lock <nick|#userid> [seconds]` in `plugins/stream_cam` holds the director on one bot, so a
paid "hero" event no longer depends on the director guessing right.
