# Models, sounds and reference plugins

Everything the nine systems need from outside the current repository: which file, which source, what
the licence allows, where it lands, and how it is verified. Nothing here is installed yet — this is
the shopping list and the rules for buying.

## Rules

1. **A model is a rendering cost.** The capture client renders on llvmpipe (software OpenGL) and sits
   at 220–230 % CPU with the picture live. A model that doubles the vertex count of twenty bots can
   drop the stream the way `crowd_pile` did. Ship one model, watch `docker stats` and the watchdog's
   `logAgeSec`, then ship the next.
2. **A missing asset is a silent event, not an error.** `precache_model` / `precache_sound` must list
   every file a handler can ask for, at `plugin_precache` time. A file that is missing on disk makes
   the event happen without its model or its sound and nothing in the log explains it.
3. **The RCON line cannot carry a path.** Anything a viewer pays for is a *number* or a token from the
   catalogue; file names live in `params` only where `src/command.ts` deliberately drops them
   (`music`, `sound`, `soundRed`, `soundGreen`, `onlyMusic`, `say`, `short`).
4. **Licence first.** Community model packs are usually free to redistribute but are not licensed
   uniformly, and the big Pawn plugins are GPL. Copying their code into `donation_events` would put
   this repository under the GPL — take the *idea* and write the handler, or copy the code knowingly.
5. **Stream audio goes through the existing pipeline.** `infra/sounds/*.mp3` is rendered to WAV at
   image build time (`infra/stream/Dockerfile`), peak-normalised to -0.9 dBFS, and played by
   `infra/stream/voice.sh`. A cue that is 2 dB under its twin is a cue nobody hears; the level check
   is `node scripts/wav-levels.ts <file.wav>`.

## Player models

| Model | Used by | Source | Target path | Notes |
|---|---|---|---|---|
| `zombie_source` | S1 `nemesis`, `outbreak`, S7 `zombie_skin` | Zombie Plague model packs (community, check the pack README) | `infra/models/player/zombie_source/zombie_source.mdl` | the standard ZP zombie; needs `T`/`CT` copies under both team folders |
| `zombie_classic` | S7 `model_madness` variant | same packs | `infra/models/player/zombie_classic/` | lighter geometry than `zombie_source`, better for llvmpipe |
| `chicken` | S4 `hex_wave`, S7 `chicken_plague` | CSO/ZP packs | `infra/models/player/chicken/chicken.mdl` | the funniest single asset in the whole plan; verify it renders without a weapon in hand |
| `vip`/`leet`/`gign` | S7 `model_madness` | stock CS 1.6 | already in the image | free variety: stock models cost nothing to add |

How a model is applied: `cs_set_user_model(id, "zombie_source")` from `<cstrike>`, and reset with
`cs_reset_user_model(id)`. Both are per player and survive until the next call, so a model is a
*claim* like any cvar: the effect that set it must reset it on its clock, and `ClearAll` must reset
every slot. Storage: player models live under `cstrike/models/player/<name>/<name>.mdl`, with the
same file copied into the `T`/`CT` subfolders when the model is team-bound.

## Weapon models (S3)

`zp_extra_bazooka`, `zp_extra_plasmagun` and `zp_extra_lasermine` are the reference implementations.
A custom weapon is not `give_item`: it is an entity created by the plugin, with

- `models/v_<name>.mdl` (first person, never seen on the stream but required by the engine),
- `models/w_<name>.mdl` (world model — this is what the camera sees on the ground and in hand),
- `models/p_<name>.mdl` (player model, what the viewer sees in third person — the one that matters),
- a `Ham_Weapon_PrimaryAttack` handler for the shot and an `events/` or custom sound for it.

Build the bazooka first. If the custom entity fights `csdm_lite`'s respawn re-arm, the fallback is a
`weapon_m249` with a bigger radius and a precached explosion sprite — visually weaker but stable.

## Sounds

| Sound | Used by | Source | Path |
|---|---|---|---|
| zombie growl | S1, S7 | ZP ambience packs | `cstrike/sound/zombie/…` + `precache_sound` |
| air-raid siren | S8 `siren`, `airstrike` | public-domain siren or CC0 (freesound) | `infra/sounds/siren.mp3` → WAV at build |
| countdown voice | S8 `announcer_countdown` | TTS through the existing `src/voice.ts` pipeline, or a recorded announcer | `infra/sounds/countdown.mp3` |
| film quote | S8 `quotes_pack` | TTS, or a licensed clip — a quote is a copyright risk, TTS is not | `infra/sounds/quote_<n>.mp3` |
| knife hit, explosion | S1, S3, S6 | stock CS 1.6 (`weapons/knife_hit1.wav`, `ambience/thunder_clap.wav`) | already precached |

Stock files are the safe default: they are already in the image, already precached by
`plugin_precache`, and cost nothing. Custom audio belongs on the stream side (`infra/sounds`) where
`ffmpeg` normalises it, not on the game side where a missing file is silent.

## Reference plugins (ideas and assets, not dependencies)

None of these are installed on this server. Our plugin is custom and the server is bot-only, so a
reference is read for its *mechanics* and, where the licence allows, for its assets.

| Project | Licence | What we take | What we do not take |
|---|---|---|---|
| Zombie Plague 4.3 / 5.0 (AMXX) | GPL — check before copying code | round modes (nemesis/survivor/swarm/assassin), class tables, extra items, model packs | the plugin itself: it needs human players and its own round loop |
| Zombie Plague extras (`zp_extra_bazooka`, `zp_extra_plasmagun`, `zp_extra_lasermine`) | GPL | the entity approach and the `v_`/`w_`/`p_` models | the code, unless we accept the GPL for `donation_events` |
| Warcraft 3 FT (AMXX) | GPL | skill list and balance (chain lightning, hex, blink, vampiric aura) | the XP/level system: our donations are not a grind |
| Superhero (AMXX) | GPL | the "random power" idea | hero models, unless the pack is free to redistribute |
| GunGame (AMXX) | GPL | the weapon ladder | its own scoring loop; ours is `team_war` |
| Hide'n'Seek (AMXX) | GPL | freeze-on-sight rule | the melee-only movement rules |
| ChaosModV (GTA V) | GPL-3.0 | effect taxonomy, timed vs one-shot, the screen/meta ideas, chat voting as a hook | any code: it is GTA V, ScriptHook and C++ |
| `plugins/chaos_core` (this repo) | ours | `amx_chaos force` for `chaos_plague` | — |

The GPL column matters: copying a GPL handler into `donation_events` makes this plugin GPL. Reading it,
reimplementing the mechanic and using freely redistributable assets does not. When in doubt, write the
handler from the description in `systems.md` and note the reference here.

## Verification checklist (per asset)

1. the file exists at the path in the table and is listed in `plugin_precache`;
2. `amx_de codes` reports the code, and firing it by hand from the panel shows the model/sound;
3. `docker stats` for the stream container stays inside the pre-asset envelope, and the watchdog does
   not report `frozen: true` or a growing `logAgeSec`;
4. the picture survives a map change with the asset loaded (`fy_simpsons`, the heaviest map);
5. `node scripts/wav-levels.ts` for every new WAV: peak within ~1 dB of its neighbours;
6. the licence of the pack is written down in this file before the file lands in `infra/`.
