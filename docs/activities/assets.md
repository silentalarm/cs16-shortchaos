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
| `nemesis` | S1 `nemesis` | painted here over the stock `urban` soldier (`infra/models/build/nemesis.mjs`, `skin.mjs`) | `infra/models/player/nemesis/nemesis.mdl` | the film's Nemesis: long black leather coat, steel buckles, oversized boots, pale stapled head with a jaw grille, muscle piping and blood; keeps the stock skeleton, sequences and the hand bone the weapon hangs on |
| `survivor` | S1 `survivor` | painted here over the stock `leet` soldier (`infra/models/build/survivor.mjs`, `skin.mjs`) | `infra/models/player/survivor/survivor.mdl` | the film's survivor (Alice): bare arms, black top, crossing shoulder holsters, dark red belt, cargo trousers, dark sunglasses - a bare head, because a helmet cannot be painted into hair |
| `zombie_source` | S1 `nemesis`, `outbreak`, S7 `zombie_skin` | Zombie Plague model packs (community, check the pack README) | `infra/models/player/zombie_source/zombie_source.mdl` | the standard ZP zombie; needs `T`/`CT` copies under both team folders |
| `zombie_classic` | S7 `model_madness` variant | same packs | `infra/models/player/zombie_classic/` | lighter geometry than `zombie_source`, better for llvmpipe |
| `chicken` | S4 `hex_wave`, S7 `chicken_plague` | CSO/ZP packs | `infra/models/player/chicken/chicken.mdl` | the funniest single asset in the whole plan; verify it renders without a weapon in hand |
| `vip`/`leet`/`gign` | S7 `model_madness` | stock CS 1.6 | already in the image | free variety: stock models cost nothing to add |

How a model is applied: `cs_set_user_model(id, "zombie_source")` from `<cstrike>`, and reset with
`cs_reset_user_model(id)`. Both are per player and survive until the next call, so a model is a
*claim* like any cvar: the effect that set it must reset it on its clock, and `ClearAll` must reset
every slot. Storage: player models live under `cstrike/models/player/<name>/<name>.mdl`, with the
same file copied into the `T`/`CT` subfolders when the model is team-bound.

The two hero looks are wired (`ArmHero` → `DressHeroModel`, undone in `EndHero` and in
`ResetEventState`) and they follow the rule above with one extra guard: `g_heroLookSet` records that *this*
plugin put the model on, because `cs_reset_user_model` lifts the model lock of anybody — a hero's clock
must not take the `hex_wave` chicken off the same slot. `ArmHero` is also the respawn path, so a hero that
dies comes back wearing its own skin.

## Weapon models (S3)

`zp_extra_bazooka`, `zp_extra_plasmagun` and `zp_extra_lasermine` are the reference implementations.
A custom weapon is not `give_item`: it is an entity created by the plugin, with

- `models/v_<name>.mdl` (first person, never seen on the stream but required by the engine),
- `models/w_<name>.mdl` (world model — this is what the camera sees on the ground and in hand),
- `models/p_<name>.mdl` (player model, what the viewer sees in third person — the one that matters),
- a `Ham_Weapon_PrimaryAttack` handler for the shot and an `events/` or custom sound for it.

Build the bazooka first. If the custom entity fights `csdm_lite`'s respawn re-arm, the fallback is a
`weapon_m249` with a bigger radius and a precached explosion sprite — visually weaker but stable.

### The hero looks: painted by place, not re-coloured

`infra/models/build/{nemesis,survivor}.mjs` write **new** files; the stock soldiers they are built on are
only read:

| Output | What it is | Source (read, never written) |
|---|---|---|
| `infra/models/player/nemesis/nemesis.mdl` | the nemesis' player model | `models/player/urban/urban.mdl` from the image |
| `infra/models/weapons/p_nemesis_knife.mdl` | the knife in its hand | `models/p_knife.mdl` from the image |
| `infra/models/player/survivor/survivor.mdl` | the survivor's player model | `models/player/leet/leet.mdl` from the image |

**Why they are painted and not re-coloured.** A re-colour (`reskin`) repaints the whole 512×512 sheet with
one palette: it cannot tell a sleeve from a boot, and the first version of these two models showed it - "the
same soldier, in red" and "the same soldier, in frost". A CS 1.6 player model wears **one** picture, and every
pixel of it knows the bone of the point of the body it colours, so `paint` (SMAK) is handed, per pixel, that
bone, the normal, the place in model space and the light the stock artist painted there. `skin.mjs` turns the
bone into the thing it carries (`partOf`: head, neck, torso, arm, hand, pelvis, thigh, calf, boot) and
`litBy` gives the new colour at the old pixel's brightness next to its neighbours, so folds, seams and the
buckles the stock artist drew survive the repaint.

- **Nemesis** (film: *Resident Evil: Apocalypse*, 2004): distressed black leather over spine, arms and
  thighs with the hem at mid-shin; steel buckles on two chest straps and a thigh strap; oversized boots with
  steel toes and soles; the pale silicone head the prosthetics team made - staples round the crown and down a
  cheek, a metal grille over the jaw, patches of exposed muscle; tubes of muscle ("grotesque piping") read
  from one noise in model space, so they run across a texture seam instead of stopping at it; blood soaked
  into the leather and four wounds.
- **Survivor** (the same film's Alice): bare arms and hands, a black tank top, two shoulder holsters crossing
  the chest, a dark red belt with a steel buckle, cargo trousers with pocket seams, boots, and the head
  painted as pale skin under red-brown hair with dark sunglasses (the stock `Chrome3.bmp` lens, which reads as
  two white bulbs at stream scale, is painted to a dark lens with one reflection). The source is `leet`, not
  `gign`, because a helmet and a visor are the one thing a skin cannot paint away.

**Why not a body of our own.** The engine animates a player model by the model's own sequences on the stock
bone chain (`Bip01` … `Bip01 R Hand`, where the weapon hangs), and SMAK builds a rig, not a copied biped - a
body of our own would be a frozen silhouette with a knife. The painted files keep the 53-55 bones, the 111
sequences and every event. `smak`'s own `check(..., { source })` runs against the original, so a file this
pipeline damaged fails the build instead of the stream. What painting cannot do is change the **silhouette**:
a coat grown as new geometry (a `turn` surface on the pelvis, in the empty second bodypart) and a bare head
grafted from another stock model are the next step if the skin alone is not enough; both change the mesh and
must be judged on a picture, not on the numbers.

The stock files are Valve's and **not committed**: the scripts take them out of the game image
(`docker cp <cs16-hlds container>:/hlds/cstrike/models/... .tmp-stock/`) and the generated files are what goes
into the repository and the image. Regenerate the models and their pictures with:

```
node infra/models/build/nemesis.mjs          # STOCK_DIR=... to point at another copy of the stock files
node infra/models/build/survivor.mjs
node infra/models/build/sheets.mjs           # the pictures below, next to the models
```

Each build writes the painted picture itself (`nemesis_SEAL_Working1.png`, `survivor_Arab_dmbase1.png`);
`sheets.mjs` draws six views, a front, a side and the head close up for both, plus
`nemesis_vs_stock_urban.png` - the stock soldier, the nemesis and the survivor to one scale. Those pictures
are the check that cannot be automated: a build that PASSes the engine check can still look wrong.

How the plugin uses them (`ArmHero` → `DressHeroModel`, undone in `EndHero`/`ResetEventState`):
`cs_set_user_model(id, "nemesis")` for the hero (so a respawn wears it again) and the knife through the
player's `weaponmodel` field - the same field the bazooka writes - re-applied from the kit sweep because the
engine rewrites it on every weapon switch. Both belong in `EndHero` and in a full reset as well: a model and a
weapon model outlive a clock on their own.

**Where a model has to arrive before it is seen - twice.** `infra/entrypoint.sh` copies the `.mdl` files into
the server volume (`server-data`), where `file_exists` and `precache_model` find them; `infra/stream/entrypoint.sh`
then fills the capture client's own volume (`client-data`) from it, because the client renders the game from its
own copy of `cstrike/`. That second fill used to be `--skip-old-files`, which is right for the tens of thousands
of Steam files and wrong for the four directories this repository writes: a repainted hero never replaced the copy
the client already had, so the server precached the new model, the event ran, and the stream kept drawing the
**stock soldier the model was built on**. Reported as "the nemesis/survivor textures do not apply to the model",
and nothing in any log says so - the file is there, it is precached, and it is the wrong build. The four
directories are refreshed by content now (`refresh_published`); when a rebuild still looks unchanged on the
stream, compare the two volumes before touching the model:

```powershell
docker run --rm -v cs16-youtube_server-data:/server:ro -v cs16-youtube_client-data:/game:ro `
  --entrypoint sh cs16-stream:local -c "cmp /server/cstrike/models/player/nemesis/nemesis.mdl /game/cstrike/models/player/nemesis/nemesis.mdl && echo same"
```

### Our own bazooka: `infra/models/weapons/`


The community packs above are a licence question, so the bazooka is made here instead. It is generated,
not painted: `infra/models/build/bazooka.mjs` builds it with **SMAK** (`Deoroot/smak`, MIT, Node, no
dependencies, no `studiomdl`, no Blender) and the two `.mdl` files are committed, so a machine that never
clones SMAK can still build the image.

| File | What it is | Shape |
|---|---|---|
| `infra/models/weapons/w_bazooka.mdl` | world model — what a dropped launcher wears | 1 bone (`Line02`), 1 frame `idle`, like `w_ak47.mdl` |
| `infra/models/weapons/p_bazooka.mdl` | player model — what the camera sees in a bot's hand | the stock `p_ak47.mdl` with our piece swapped in: Valve's 13 bones, frames and `idle`, the mesh on `Line02`, the bone that carries the AK |

Both: one `studio` bodypart, 176 triangles, one 512×256 texture inside the file (`bazooka_skin.bmp`),
`smak check --engine goldsrc` → PASS. The image copies them flat into `cstrike/models` (`infra/Dockerfile`),
which is where CS keeps its own `v_`/`w_`/`p_` files.

**Why the player model is a stock rifle with our mesh in it.** A hand-written 13-bone table was tried
first, and the launcher was drawn at the bot's feet: `buildMdl` stores every corner in the space of the
bone that carries it (it multiplies by the inverse of the bone's rest matrix), so the offset that was meant
to lift the piece into the hand was subtracted straight back out — the rebuilt file came out *byte-identical*
to the previous one, which is how the no-op was caught. `swapMesh` does not have that problem: it copies the
engine-facing parts of `p_ak47.mdl` (bones, frames, sequences, the carrying bone) and only replaces the
geometry, with `size: "own"` (the launcher keeps its 42 units) and the grip anchored where the AK's grip is.
If the engine draws the bazooka anywhere but the hand now, it draws an AK there too.

The placement itself is pinned by a test, in numbers rather than in a comment: a studio model stores every
corner in the space of the bone that carries it, so `test/models.test.ts` reads the vertices back out of the
committed file, checks that all of them hang on `Line02`, and checks that their box sits inside the AK's own
`Line02` box with room for a longer weapon (the rifle's is -1.2..1.3 / -0.9..11.4 / -7.8..28.8, measured with
`smak info` on Valve's file). A piece left in model space - the "launcher at the bot's feet" bug - is some
50 units away on x and z and fails those lines.

How the plugin uses them (`donation_events`, `bazooka_drop`): `p_bazooka.mdl` is written into the carrier's
own `weaponmodel` field - the one the engine reads when it draws a player's weapon in third person - so the
camera sees a bot holding the launcher rather than a prop near it. The game rewrites that field on every
weapon switch and every spawn, so the plugin re-writes it from a 0.25 s tick. `w_bazooka.mdl` is the
world model and has no user yet: it is what a launcher lying on the ground wears the day one is dropped
there. The rocket is not a model at all - it is `sprites/zerogxplode.spr` on an additive entity, which the
event already precaches for its explosions.

The generator also holds the two numbers that decide whether it reads as a weapon: the kit puts the web of
the hand at `z = 0`, so the grip's top is that plane and `receiver.z` (the tube's underside) must sit on it —
a tube lifted off it leaves the grip hanging in the air, which is exactly what the first version did with
`z: 2.2`. The script builds the tube once without a grip to measure its underside and refuses to write a
model where the two do not meet (`side view: tube z 0.00..6.30, grip down to z -4.83`).

Rebuild them with:

```
git clone https://github.com/Deoroot/smak ../_tools/smak     # beside the repository, or set SMAK_DIR
docker cp <a cs16-hlds container>:/hlds/cstrike/models/p_ak47.mdl .tmp-stock/p_ak47.mdl
node infra/models/build/bazooka.mjs                            # writes the two .mdl plus bazooka_sheet.png
node ../_tools/smak/bin/smak.mjs check infra/models/weapons/p_bazooka.mdl --engine goldsrc
```

`bazooka_sheet.png` is six views of the shape, written beside the models: it is the file a human looks at
before the image is built, because the build only says PASS, not "that looks like a bazooka".

Not made yet: `v_bazooka.mdl` (the first-person view model — the stream never sees it, because the holder is
a bot; it is needed the day a human holds this weapon). `p_` is its base: the same mesh on a hand bone, plus
the `draw`/`shoot`/`reload` sequence order the engine asks for by number.

## Sounds

| Sound | Used by | Source | Path |
|---|---|---|---|
| ice crack | S3 `freeze_nades` | rendered here (`src/sound.ts`, `infra/sounds/generate.ts`) at image build: snap + crystalline shimmer + low body | `cstrike/sound/freeze/ice_crack.wav` |
| zombie growl | S1, S7 | ZP ambience packs | `cstrike/sound/zombie/…` + `precache_sound` |
| air-raid siren | S8 `siren`, S6 `airstrike` | synthesised in `src/music.ts` (`TRACKS.siren`, `gain: 2.5`) — no external file, no licence | `/usr/share/cs16/music/siren.wav` at build |
| countdown voice | S8 `announcer_countdown` | TTS through `infra/stream/voice.sh` (`countdownCues`), no asset | request files in `/overlay/voice` |
| film quote | S8 `quotes_pack` | TTS of the viewer's sanitised phrase, or the plugin's built-in ASCII pack | `/overlay/voice` |
| knife hit, explosion | S1, S3, S6 | stock CS 1.6 (`weapons/knife_hit1.wav`, `ambience/thunder_clap.wav`) | already precached |

Stock files are the safe default: they are already in the image, already precached by
`plugin_precache`, and cost nothing. A custom *game* sound has one extra requirement the stock ones do
not: the capture client plays only files it has, so the WAV is rendered at build time, shipped in the
game image, and synced into the `/hlds` volume by `infra/entrypoint.sh` — the client copies `cstrike/`
from that volume. `freeze/ice_crack.wav` is the first one; `src/sound.ts` is where the next one goes.

Two sound rules learned on the stream:

- **entity 0 is the world origin, not "everywhere".** `emit_sound(0, CHAN_AUTO, …)` emits from
  `(0 0 0)` and `ATTN_NORM` fades the sample with the distance from there, so a grenade bang that the
  whole field could see was inaudible. `PlaySoundAt(origin, sample)` parks a reusable `info_target` at the
  event and emits from it.
- **a stream cue is not a narrator.** The per-donation espeak line ("Петя, 900 рублей. Выпало: …") was
  removed: the overlay and the game chat already name the donation, and a synthetic voice over a gunfight
  is noise. Events schedule their bed and their file cues only (`announcementFor`, `donationAnnouncement`).

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
4. the picture survives a map change with the asset loaded (`fy_aztec`, the heaviest map);
5. `node scripts/wav-levels.ts` for every new WAV: peak within ~1 dB of its neighbours;
6. the licence of the pack is written down in this file before the file lands in `infra/`.
