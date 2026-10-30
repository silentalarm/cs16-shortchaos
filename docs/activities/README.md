# The activity backlog: 50 codes, nine systems

`config/activities.json` is what is on sale right now. This directory is the plan: every activity
the stream is supposed to have, what it needs from the game and from the capture container, and in
which order it gets built. The two must not drift — a code that exists here and not in the catalogue
is a plan, a code in the catalogue and not here is a bug.

## The deal after the 2026-10 reset

- **kept (6):** `glass_cannon`, `lightsaber_duel`, `meteor_shower`, `one_bullet`, `red_light`,
  `he_party` (stays, although it is off sale);
- **removed (17):** `bot_nick`, `bless_bot`, `meat_round`, `bot_phrase`, `knives_only`,
  `curse_leader`, `moon_gravity`, `awp_only`, `bounty`, `bot_rain`, `hot_potato`, `chaos_burst`,
  `terminators`, `zombie_round`, `boss_raid`, `terminator_one`, `map_change` — they leave the
  catalogue *and* the Pawn plugin, because `test/plugin-contract.test.ts` refuses a registered
  handler nobody can buy and a catalogue code without a handler;
- **new (44)** in nine systems, see `catalogue.md`.

## Why systems and not 44 handlers

The mods worth copying do not sell effects, they sell **systems with parameters**: Zombie Plague
sells round modes, classes and items; Warcraft 3 FT sells races and skills; GunGame sells one
ladder. One handler per idea is 44 functions nobody can retune without a recompile and a new image.
One system with `params` is five codes and a text edit.

## Files

| File | What it answers |
|---|---|
| `catalogue.md` | the 50 codes with status: what is on sale, what is built, what is only a plan |
| `systems.md` | the nine systems: mechanics, parameters, codes, sources of the idea, risks |
| `assets.md` | models, sounds and reference plugins: source, licence, target path, how it is checked |
| `roadmap.md` | the order of work, one stage per system, with a definition of done |

## Adding one activity

1. read the system in `systems.md`; a code is a preset of that system's parameters;
2. `config/activities.json`: unique `code`, `price >= minAmount`, `duration`; for a `seconds`
   activity the same clock in `params.seconds` — the plugin reads the length from the RCON line, not
   from the catalogue;
3. `plugins/donation_events/donation_events.sma`: a handler, one `RegisterDonationEffect` line, its
   own undo in `EndEffectState`, and `StartEffectTimer` when it lasts;
4. `npm test`, rebuild the image, `amx_de codes` must list the new code;
5. mark the row in `catalogue.md` and tick the stage in `roadmap.md`.

Rules the tests enforce today: codes match `^[a-z][a-z0-9_]{2,31}$`; `announce` is printable ASCII,
64 characters at most; `seconds` is 1..600; the file stays sorted by `price`; an enabled entry costs
exactly one `minAmount` step and passes its clock in `params.seconds`.
