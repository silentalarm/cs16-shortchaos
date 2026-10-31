# The 50 codes

Status legend: **on sale** lives in `config/activities.json` with `enabled: true`; **kept** is in the
catalogue but off sale; **planned** is described here and not written yet. A code becomes
`ready` only when the handler is merged, the contract tests pass and `amx_de codes` reports it.

Every new code ships as `price: 50`, `duration: "seconds"`, `params.seconds` equal to its clock and
`params.maxNameLength: 16`, so a donation can rename the bot it bought. Two exceptions are marked in
the table: `he_party` (kept, 60 s) and `quotes_pack` (`instant` — it must stay `enabled: false`
until `test/activities.test.ts` is relaxed to allow an instant entry on sale).

## Kept

| # | code | What the viewer sees | sec | params | status |
|---|---|---|---|---|---|
| 1 | `glass_cannon` | one bot: 1000 HP, M249, no reload, red glow; role moves on death | 15 | `health=1000 stock=0` | on sale |
| 2 | `lightsaber_duel` | knives only, 25 HP, ×1.4 speed, team glow, opera bed | 30 | `health=25 music=… onlyMusic=1` | on sale |
| 3 | `meteor_shower` | 43 explosions a second in a radius around the bots, 2 damage each | 15 | `damage=2 radius=320` | on sale |
| 4 | `one_bullet` | one round in the clip, then knives | 15 | — | on sale |
| 5 | `red_light` | 1.5 s frozen / 2 s moving, repeating, broadcast cues instead of stock | 15 | `stock=0 soundRed soundGreen` | on sale |
| 6 | `he_party` | every weapon taken away, knife and endless HE grenades | 60 | `seconds=60` | kept |

## S1 — round modes (Zombie Plague)

| # | code | What the viewer sees | sec | params | status |
|---|---|---|---|---|---|
| 7 | `nemesis` | one bot: HP = base + perBot×alive bots, knife at 250, ×1.3 speed, camera locked on it | 60 | `baseHealth=1500 perBot=600 knife=250 speed=1.3` | on sale |
| 8 | `survivor` | one bot: HP = 1200 + 40×bots, M249 + knife, camera on it | 60 | `baseHealth=1200 perBot=40 weapon=weapon_m249 speed=1.1` | on sale |
| 9 | `outbreak` | a third of the bots start infected (1500 HP, knife); a knife kill converts the victim | 60 | `share=33 health=1500 infectKnife=150 speed=1.15` | on sale |
| 10 | `juggernaut` | one bot at 5000 HP with a knife; whoever kills it becomes it | 60 | `baseHealth=5000 perBot=0 knife=200 speed=1.2 transfer=1` | on sale |
| 11 | `assassin` | one semi-transparent bot with a knife; the role passes on death | 45 | `baseHealth=250 perBot=0 knife=200 speed=1.25 alpha=140` | on sale (see note) |
| 12 | `chaos_plague` | the boss, the infection and `amx_chaos force` in one event | 60 | `baseHealth=1500 perBot=300 knife=250 share=25 health=1500 infectKnife=150` | on sale |

## S2 — classes (Zombie Plague classes)

| # | code | What the viewer sees | sec | params | status |
|---|---|---|---|---|---|
| 13 | `raptors` | 5 bots: 3000 HP, ×1.2 speed, knife only, thrown further by damage | 45 | `count=5 health=3000 speed=1.2 knockback=160` | on sale |
| 14 | `brutes` | 4 bots: 7000 HP, ×0.9 speed, hard to push | 45 | `count=4 health=7000 speed=0.9 knockback=55` | on sale |
| 15 | `runners` | the whole field at 75 HP and ×1.15 speed | 45 | `health=75 speed=1.15` | on sale |
| 16 | `jumpers` | the whole field at 58 % gravity, light jumps | 30 | `gravity=0.58` | on sale |
| 17 | `regenerators` | 4 bots recover 35 HP a second | 45 | `count=4 regen=35` | on sale |

## S3 — items (Zombie Plague extras)

| # | code | What the viewer sees | sec | params | status |
|---|---|---|---|---|---|
| 18 | `fire_grenades` | an HE sets bots on fire: 60 damage a tick for 15 s, orange sprite | 30 | `damage=60 burn=15` | ready (off sale, YaPB does not throw) |
| 19 | `freeze_nades` | a flashbang freezes everybody in the blast for 6 s | 30 | `freeze=6 radius=300` | planned |
| 20 | `bazooka_drop` | one bot gets a rocket launcher, 500 blast damage, camera on it | 30 | `damage=500 radius=320 recharge=15` | planned |
| 21 | `plasma_rifle` | one bot with an energy rifle: 90 damage, blue tracers, 50 rounds | 30 | `damage=90 ammo=50` | planned |
| 22 | `laser_mines` | three mines on the map, a beam burns whoever crosses it | 45 | `count=3 damage=40` | planned |

## S4 — skills (Warcraft 3 FT / Superhero)

| # | code | What the viewer sees | sec | params | status |
|---|---|---|---|---|---|
| 23 | `hex_wave` | a random bot turns into a chicken: model swap, no weapons, ×0.6 speed | 20 | `seconds=20 model=chicken` | ready (off sale, no .mdl) |
| 24 | `chain_lightning` | every 3 s a bolt jumps through three bots in a row | 20 | `targets=3 damage=40 period=3` | ready (off sale) |
| 25 | `blink_bots` | every bot teleports 200 units forward every 4 s | 20 | `distance=200 period=4` | ready (off sale) |
| 26 | `hero_roulette` | one bot gets a random power: invisibility, ×2 speed, 500 HP or an endless deagle | 45 | `pool=invisible,speed,health,deagle` | ready (off sale) |
| 27 | `vampiric_aura` | everybody heals 50 % of the damage they deal | 30 | `share=50` | ready (off sale) |

## S5 — chases and arenas (GunGame, Hide'n'Seek, arena formats)

| # | code | What the viewer sees | sec | params | status |
|---|---|---|---|---|---|
| 28 | `guntrain` | GunGame ladder: a kill moves the bot one weapon up, panel shows the leader | 60 | `ladder=glock18,usp,deagle,mp5navy,ak47,m4a1,awp,knife` | planned |
| 29 | `statues` | a bot freezes while another bot can see it — Hide'n'Seek on autopilot | 30 | `seconds=30` | planned |
| 30 | `head_hunter` | the marked bot's killer gets an AWP for 15 s; the mark moves every 3 s | 45 | `reward=weapon_awp hold=15 period=3` | planned |
| 31 | `king_of_the_hill` | hold the map centre for 3 s and keep 300 HP and an M249 | 60 | `radius=200 hold=3 health=300` | planned |
| 32 | `duel_bell` | every 10 s two random bots are dropped in the middle for a 1 HP knife duel | 40 | `period=10 health=1` | planned |

## S6 — world and physics (ChaosModV)

| # | code | What the viewer sees | sec | params | status |
|---|---|---|---|---|---|
| 33 | `airstrike` | ten explosions converging on the frag leader | 20 | `strikes=10 damage=120 radius=300` | planned |
| 34 | `weapon_rain` | one weapon drops every 2 s, five in total (hard cap, see llvmpipe) | 20 | `count=5 period=2` | planned |
| 35 | `quake` | every 0.7 s everyone is shoved by a random impulse | 15 | `period=0.7 force=400` | planned |
| 36 | `fire_ring` | a damage zone shrinks towards the centre | 30 | `damage=5 period=1 shrink=40` | planned |
| 37 | `invert_velocity` | every bot's velocity is negated: running forwards goes backwards | 10 | `period=0.2` | planned |
| 38 | `low_gravity_knives` | gravity 150, knives only: jump duels | 25 | `gravity=150` | planned |

## S7 — models

| # | code | What the viewer sees | sec | params | status |
|---|---|---|---|---|---|
| 39 | `zombie_skin` | every bot in a zombie model, growls in the mix | 60 | `model=zombie_source` | planned |
| 40 | `chicken_plague` | half the bots are chickens | 45 | `share=50 model=chicken` | planned |
| 41 | `model_madness` | every bot gets a different model from the pack | 45 | `pack=zombie,chicken,leet` | planned |

## S8 — sound and announcer

| # | code | What the viewer hears | sec | params | status |
|---|---|---|---|---|---|
| 42 | `announcer_countdown` | an announcer counts 3-2-1 before the fight starts | 10 | `sound=/usr/share/cs16/sounds/countdown.wav` | planned |
| 43 | `quotes_pack` | a bot says a film line, with the subtitle in chat | instant | `maxPhraseLength=40` | planned |
| 44 | `siren` | an air-raid siren over the field | 15 | `sound=/usr/share/cs16/sounds/siren.wav` | planned |
| 45 | `music_swap` | the music bed changes for 20 s | 20 | `music=/game/cstrike/sound/… onlyMusic=1` | planned |

## S9 — stream meta effects (ffmpeg, the game is untouched)

| # | code | What the viewer sees | sec | params | status |
|---|---|---|---|---|---|
| 46 | `slowmo_stream` | the whole broadcast in slow motion, video and audio | 6 | `factor=0.35` | planned |
| 47 | `upside_down` | the picture rotates 180° | 15 | — | planned |
| 48 | `dvd_screensaver` | the frame shrinks and bounces over a black screen | 8 | — | planned |
| 49 | `fake_crash` | the picture freezes, an error window appears, then everything returns | 4 | — | planned |
| 50 | `credits` | credits roll with the bots' and donors' names | 10 | — | planned |

## Not in this list, on purpose

**The assassin has no target yet.** It is a semi-transparent knife hero, and the camera follows it - but
"hunts the frag leader" needs the bot to *walk towards* somebody, and the pinned YaPB 4.4.957 ships no
per-bot goal natives (`docs/runbook.md`, "Phase 0: what the bot plugin actually exposes"). Until a YaPB
build with `ext/amxx` is pinned, the assassin hunts whatever its own AI picks; the code is honest about
it (`alpha`, `knife`, `speed`) and the name promises more than the bot does.

**Removed with the reset (17):** listed in `README.md`. They were disabled, and the owner asked for
everything disabled to go except `he_party`.

**Rejected earlier, do not re-propose without a new reason** (`docs/events.md`): `crowd_pile` (froze
the capture client twice), `sniper_moment` (paid shots happened off camera), `ice_floor` (zero
friction was invisible), `bet_on_bot` (no payout), `flip_sides`, `invisible_bots`, `duel_pairs`,
`friendly_fire`, `traitor`.

**Rejected as filler (2026-10, owner's call):** "frag = 2 points", bot nickname shuffles, a donor
billboard, score wipes, a stock horn, bot "roasts", a random weapon on kill, and seven "X only"
weapon-pool variants. No clip, no story, no reason to pay a second time.

## Open decisions

1. **Price and rarity.** 50 codes at 50 RUB give every code a 2 % chance per step. Either add
   `weight` to the catalogue schema (a rarity column, honoured by `draw()` in `src/mapping.ts`), or
   keep a wave of 10–12 enabled entries rotated through the panel. Decide before S1 goes on sale.
2. **Instant entries on sale.** The catalogue test currently demands that every enabled entry is a
   `seconds` clock with `params.seconds`; `quotes_pack` is `instant`, so it stays off sale until
   that rule is split into "clock entries" and "instant entries".

