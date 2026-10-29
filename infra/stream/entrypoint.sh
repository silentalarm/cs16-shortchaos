#!/bin/bash
# Renders the local CS 1.6 server on a virtual display and pushes it to YouTube over RTMP.
#
# Three processes, each restarted by its own loop:
#   Xvfb   - virtual 24-bit display, no GPU needed
#   xash3d - open-source GoldSrc engine, connects to the server and spectates
#   ffmpeg - grabs the display with x11grab, composes the final frame, encodes H.264/AAC
#
# The client joins by itself: see write_client_config() for why it is done through a config file
# and not with `+connect`. Nothing here needs a keyboard, a Steam account or a window manager.
#
# Layouts (STREAM_ORIENTATION):
#   vertical   - 9:16 canvas for the YouTube Shorts feed (the default): the 4:3 game frame is
#                scaled to the canvas width and placed in the upper part, the band below is left
#                for donations text and for the Shorts UI (right edge and bottom are covered by
#                the app: like/comment buttons, title). The engine still renders 4:3, because
#                stretching the game itself to 9:16 ruins the field of view.
#   horizontal - plain 16:9 passthrough, the old behaviour.
#
# Output (STREAM_OUTPUT / YOUTUBE_STREAM_KEY):
#   empty STREAM_OUTPUT - push to YouTube RTMP, YOUTUBE_STREAM_KEY is required;
#   STREAM_OUTPUT=path  - record to that file for STREAM_RECORD_SEC seconds and exit, so the
#                         picture can be reviewed without going live and without a stream key;
#   STREAM_OUTPUT=url   - push to any receiver: rtmp:// (flv) is the same code path YouTube uses,
#                         which is how the local MediaMTX hub is fed for debugging, tcp:// / udp://
#                         / srt:// wrap the same encoded stream in MPEG-TS.
set -uo pipefail

GAME_DIR="${GAME_DIR:-/game}"
SERVER_DIR="${SERVER_DIR:-/server}"
# Where the encoder publishes its own telemetry (status.json + progress.txt). The control API
# mounts the same volume read-only and shows it in the admin panel.
STATUS_DIR="${STREAM_STATUS_DIR:-${GAME_DIR:-/game}/.stream}"
SERVER_ADDR="${SERVER_ADDR:-127.0.0.1:27015}"
FPS="${STREAM_FPS:-30}"
BITRATE="${STREAM_BITRATE_KBPS:-2000}"
# x264 gets a fixed thread budget: llvmpipe (software OpenGL) renders the game in the same container
# and both scale with the core count, so an unbounded encoder starves the client and the picture
# stutters in the capture itself. 2 threads keeps 720p30 well inside its budget.
ENC_THREADS="${STREAM_ENCODE_THREADS:-2}"
RTMP_BASE="${STREAM_RTMP:-rtmps://a.rtmps.youtube.com:443/live2}"
PLAYER_NAME="${STREAM_CAM_NAME:-StreamCam}"

# Spectator camera, kept in sync with plugins/stream_cam: 1 = chase locked (third person),
# 4 = OBS_IN_EYE, 6 = OBS_MAP_CHASE (map overview, no gameplay). The director itself
# switches between third and first person on the interesting moments (stcam_pov).
#
# The target itself is chosen by the game server (plugins/stream_cam): only the server knows which
# bot is alive and actually moving, and the client cannot leave the team menu it was kicked into.
# Setting STREAM_SPEC_SWITCH_SEC above zero re-enables the old client-side spec_next cycling as a
# fallback for a server that does not run the plugin.
SPEC_MODE="${STREAM_SPEC_MODE:-1}"
SPEC_SWITCH_SEC="${STREAM_SPEC_SWITCH_SEC:-0}"

# How long to wait for the spectator client to appear in the game before the encoder starts, and
# how long to let it settle after the connect line (map load + audio device open).
JOIN_TIMEOUT="${STREAM_JOIN_TIMEOUT_SEC:-90}"
JOIN_SETTLE="${STREAM_JOIN_SETTLE_SEC:-6}"
AUDIO_TIMEOUT="${STREAM_AUDIO_TIMEOUT_SEC:-90}"

log() { printf '%s [stream] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# --- layout -----------------------------------------------------------------------------------
# ORIENTATION sets the default canvas and render size; every value can be overridden, the defaults
# are the ones that fit a small VPS: 720x1280 encodes in about 0.7 of a core, 1080x1920 needs 1.5.
ORIENTATION="${STREAM_ORIENTATION:-vertical}"
case "$ORIENTATION" in
  # vertical renders the client itself in 9:16. The render height is derived below from the canvas and
  # the band height, so the picture fills the frame; FILL_CANVAS switches that on.
  vertical)   DEF_OUT_W=720;  DEF_OUT_H=1280; DEF_CAP_H=0;   FILL_CANVAS=1 ;;
  horizontal) DEF_OUT_W=1280; DEF_OUT_H=720;  DEF_CAP_H=720; FILL_CANVAS=0 ;;
  *) log "STREAM_ORIENTATION must be vertical or horizontal, got '$ORIENTATION'"; exit 2 ;;
esac
OUT_W="${STREAM_WIDTH:-$DEF_OUT_W}"
OUT_H="${STREAM_HEIGHT:-$DEF_OUT_H}"
# The client renders at the canvas width: the picture is scaled down to the canvas anyway, so a wider
# render only costs CPU. This also removes two settings that used to sit stale in .env and silently
# brought the 4:3 composition back.
CAP_W=$OUT_W

# The two translucent spectator bands belong to the client overlay, not of the picture:
# CHudSpectatorGui::Draw() fills a strip of INT_YPOS(2) at the top and at the bottom of the frame, and
# this HUD defines YPOS(y) as y/10, so each strip is exactly 20% of the render height (measured: 144
# rows of a 720-row capture, 426 of 2134). Both FillRGBABlend calls are unconditional: spec_drawstatus
# only empties the strips, `hud_draw 0` removes them together with the whole HUD. So the strips are cut
# here, before the scale, and never stretched back.
#
# For the vertical layout the bands would eat 40% of the frame, so the render height is derived instead
# of configured: ask the client for canvas_height / (1 - 2 * band) rows and what survives the cut is
# exactly the canvas. Deriving it also means a stale STREAM_CAPTURE_HEIGHT in .env cannot break the
# composition, and STREAM_CAPTURE_WIDTH stays the only render knob.
BAND_PCT="${STREAM_BAND_PERCENT:-20}"
case "$BAND_PCT" in ''|*[!0-9]*) log "STREAM_BAND_PERCENT must be an integer 0..40"; exit 2 ;; esac
(( BAND_PCT <= 40 )) || { log "STREAM_BAND_PERCENT must be 0..40, got ${BAND_PCT}"; exit 2; }
if [ "$FILL_CANVAS" = 1 ]; then
  (( 100 - 2 * BAND_PCT > 0 )) || { log "STREAM_BAND_PERCENT=${BAND_PCT} leaves no picture"; exit 2; }
  CAP_H=$(( (CAP_W * OUT_H * 100) / (OUT_W * (100 - 2 * BAND_PCT)) ))
  (( CAP_H % 2 )) && CAP_H=$(( CAP_H + 1 ))
else
  CAP_H="${STREAM_CAPTURE_HEIGHT:-$DEF_CAP_H}"
fi

for v in "$OUT_W" "$OUT_H" "$CAP_W" "$CAP_H"; do
  case "$v" in ''|*[!0-9]*) log "resolution values must be integers"; exit 2 ;; esac
  (( v % 2 )) && { log "resolution values must be even for yuv420p, got $v"; exit 2; }
done

BAND_PX=$(( CAP_H * BAND_PCT / 100 ))
(( BAND_PX % 2 )) && BAND_PX=$(( BAND_PX - 1 ))
VIEW_H=$(( CAP_H - 2 * BAND_PX ))
(( VIEW_H > 0 )) || { log "STREAM_BAND_PERCENT=${BAND_PCT} leaves no picture"; exit 2; }

# Fit the visible part into the canvas by width and centre it. yuv420p requires even numbers
# everywhere: an odd size makes libx264 fail with a cryptic "width not divisible by 2".
GAME_W=$OUT_W
GAME_H=$(( OUT_W * VIEW_H / CAP_W ))
(( GAME_H % 2 )) && GAME_H=$(( GAME_H - 1 ))
(( GAME_H > OUT_H )) && GAME_H=$OUT_H
PAD_Y=$(( (OUT_H - GAME_H) / 2 ))
(( PAD_Y % 2 )) && PAD_Y=$(( PAD_Y - 1 ))
(( PAD_Y < 0 )) && PAD_Y=0

VF="crop=${CAP_W}:${VIEW_H}:0:${BAND_PX},scale=${GAME_W}:${GAME_H}:flags=bicubic"
if [ "$GAME_H" -ne "$OUT_H" ] || [ "$GAME_W" -ne "$OUT_W" ]; then
  VF="${VF},pad=${OUT_W}:${OUT_H}:0:${PAD_Y}:color=0x101014"
fi
VF="${VF},format=yuv420p"

# --- overlay -----------------------------------------------------------------------------------
# Donation text under the picture. This is the fallback: when the panel below is on it carries the
# same lines, and this layer is left out so a donation is not printed twice.
# drawtext re-reads a text file every frame (`reload=1`), so a new donation appears without
# restarting the encoder, and nothing from a viewer nickname has to be escaped into the filter
# graph. The control API writes the file through a shared volume; the placeholder below only covers
# the seconds before its first poll.
OVERLAY_TXT="${STREAM_OVERLAY_TXT:-}"
OVERLAY_FONT="${STREAM_OVERLAY_FONT:-}"
if [ -z "$OVERLAY_FONT" ]; then
  for candidate in /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
                   /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf; do
    if [ -f "$candidate" ]; then OVERLAY_FONT="$candidate"; break; fi
  done
fi

# A path inside a filter graph is escaped ('\', ':'), the file content is never parsed. Defined
# before any layer is built: the panel needs it even when the donation overlay is off.
overlay_path() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/:/\\:/g'; }

if [ -n "$OVERLAY_TXT" ] && [ -n "$OVERLAY_FONT" ]; then
  mkdir -p "$(dirname "$OVERLAY_TXT")" 2>/dev/null || true
  if [ ! -f "$OVERLAY_TXT" ]; then
    printf 'DONATE IN CHAT -> CHANGE THE GAME\n' > "$OVERLAY_TXT" 2>/dev/null || true
  fi

  if [ -f "$OVERLAY_TXT" ]; then
    OVERLAY_FONTSIZE="${STREAM_OVERLAY_FONTSIZE:-26}"
    # Vertical layout: the Shorts UI covers the bottom strip (title and buttons), so the text sits
    # higher than it would in 16:9.
    OVERLAY_MARGIN="${STREAM_OVERLAY_MARGIN:-150}"
    if [ "$ORIENTATION" != vertical ]; then OVERLAY_MARGIN="${STREAM_OVERLAY_MARGIN:-24}"; fi

    OVERLAY_VF=",drawtext=fontfile=$(overlay_path "$OVERLAY_FONT"):textfile=$(overlay_path "$OVERLAY_TXT")"\
":reload=1:fontsize=${OVERLAY_FONTSIZE}:fontcolor=white:borderw=2:bordercolor=black@0.9"\
":line_spacing=8:box=1:boxcolor=black@0.35:boxborderw=10:x=(w-text_w)/2:y=h-text_h-${OVERLAY_MARGIN}"
    log "overlay: $OVERLAY_TXT, ${OVERLAY_FONTSIZE}px, ${OVERLAY_MARGIN}px from the bottom"
  else
    log "overlay: off, $OVERLAY_TXT is not writable"
  fi
elif [ -n "$OVERLAY_TXT" ]; then
  log "overlay: off, no font found (install fonts-dejavu-core)"
else
  log "overlay: off (STREAM_OVERLAY_TXT is empty)"
fi

# --- picture panel ----------------------------------------------------------------------------
# The whole on-screen interface - the score bar, both team tops, the bot on camera, the last
# donation, how to buy the next activity - is drawn by the encoder itself with drawtext, from small
# text files the control API writes into a shared volume: one file per line.
#
# Why text and not a rendered picture: a PNG had to enter ffmpeg as an extra input, and both ways of
# feeding it froze on a live stream. `-loop 1` on the image keeps the first decoded frame forever;
# a FIFO of PNG frames (image2pipe) showed the same picture for minutes while ui.png kept changing
# on disk. drawtext re-reads its text file every frame (`reload=1`) - the mechanism the donation
# line has always used - so there is no extra input and nothing to synchronise.
#
# Why the score is a bar: drawbox cannot take its length from a file, so the advantage between the
# teams is two runs of U+2588 FULL BLOCK. Each run is anchored at its own outer edge and the two
# together always add up to the same number of blocks, so the edges never move and the bar cannot
# flicker: only the point where the runs meet moves. U+2588 is the only glyph whose advance width is
# identical in every run - U+2591 LIGHT SHADE measured 5 px narrower over twenty characters, which
# is enough to make the bar crawl.
UI_DIR="${STREAM_UI_DIR:-/overlay/ui}"
UI_TEXT="${STREAM_UI_TEXT:-1}"
UI_SIZE_BAR="${STREAM_UI_SIZE_BAR:-40}"
UI_SIZE_SCORE="${STREAM_UI_SIZE_SCORE:-28}"
UI_SIZE_TOP="${STREAM_UI_SIZE_TOP:-30}"
UI_SIZE_TARGET="${STREAM_UI_SIZE_TARGET:-36}"
UI_SIZE_LAST="${STREAM_UI_SIZE_LAST:-30}"
UI_SIZE_MENU="${STREAM_UI_SIZE_MENU:-24}"
UI_MARGIN="${STREAM_UI_MARGIN:-52}"
UI_TOP="${STREAM_UI_TOP:-36}"
UI_BOTTOM="${STREAM_UI_BOTTOM:-186}"
UI_COLOR_T="${STREAM_UI_COLOR_T:-0xDD3333}"
UI_COLOR_CT="${STREAM_UI_COLOR_CT:-0x3366DD}"
UI_COLOR_TEXT="${STREAM_UI_COLOR_TEXT:-white}"
UI_COLOR_MUTED="${STREAM_UI_COLOR_MUTED:-0xB9C2CF}"
UI_READY="ui.json"
# The two bottom lines (the last donation and how to buy the next activity) can be switched off on
# their own: the panel then keeps the race and the bot on camera and leaves the Shorts strip clean.
UI_DONATE="${STREAM_UI_DONATE:-1}"
PANEL_LAYERS=0
PANEL_VF=""

# One line of the panel. Sizes, colours and offsets all come from the environment, so the look is a
# matter of .env instead of a rebuild.
panel_add() {
  # $1 file, $2 font size, $3 colour, $4 x expression, $5 y expression, $6 extra options
  # An empty file draws nothing but keeps the graph valid: a drawtext whose textfile is missing fails
  # the whole filter graph, and after an upgrade the new files do not exist until the control API
  # writes them - while the `ui.json` left in the volume lets the wait below pass immediately.
  [ -e "$UI_DIR/$1" ] || : 2>/dev/null > "$UI_DIR/$1" || true
  PANEL_VF="${PANEL_VF},drawtext=fontfile=$(overlay_path "$OVERLAY_FONT")"\
":textfile=$(overlay_path "$UI_DIR/$1"):reload=1:fontsize=$2:fontcolor=$3"\
":borderw=2:bordercolor=black@0.85:x=$4:y=$5${6:-}"
  PANEL_LAYERS=$((PANEL_LAYERS + 1))
}

panel_setup() {
  [ "$UI_TEXT" = 1 ] || { log "ui: off (STREAM_UI_TEXT=$UI_TEXT)"; return 0; }
  [ -n "$OVERLAY_FONT" ] || { log "ui: off, no font found (install fonts-dejavu-core)"; return 0; }
  mkdir -p "$UI_DIR" 2>/dev/null || true

  local box=":box=1:boxcolor=black@0.45:boxborderw=8"
  local row_top=$((UI_TOP + 72))
  local row_target=$((UI_TOP + 124))
  local row_notice=$((UI_TOP + 174))
  local row_last=$((UI_BOTTOM + 52))

  # The bar first: the red run anchored to the left margin, the blue one to the right margin, so
  # both outer edges are fixed and only the meeting point moves. The colours are the ones the game
  # uses for the health cross and the armour shield: red side, blue side.
  panel_add bar-t.txt "$UI_SIZE_BAR" "$UI_COLOR_T" "$UI_MARGIN" "$UI_TOP"
  panel_add bar-ct.txt "$UI_SIZE_BAR" "$UI_COLOR_CT" "w-text_w-${UI_MARGIN}" "$UI_TOP"
  # The frag counts sit on the blocks at the fixed outer ends, like the number on a health bar.
  # Inset by 12 px so a two-digit number never touches the frame margin. The row is measured, not
  # guessed: on a rendered frame the blocks cover y 36..83 (centre 59.5) and a 28 px digit line at
  # y=42 covers 42..61 (centre 51.5), so the digits go 14 px below UI_TOP - an 8 px shift down.
  local score_x=$((UI_MARGIN + 12))
  local score_y=$((UI_TOP + 14))
  panel_add score-t.txt "$UI_SIZE_SCORE" "$UI_COLOR_TEXT" "$score_x" "$score_y"
  panel_add score-ct.txt "$UI_SIZE_SCORE" "$UI_COLOR_TEXT" "w-text_w-${score_x}" "$score_y"
  panel_add top-t.txt "$UI_SIZE_TOP" "$UI_COLOR_MUTED" "$UI_MARGIN" "$row_top" "$box"
  panel_add top-ct.txt "$UI_SIZE_TOP" "$UI_COLOR_MUTED" "w-text_w-${UI_MARGIN}" "$row_top" "$box"
  panel_add target.txt "$UI_SIZE_TARGET" "$UI_COLOR_TEXT" "(w-text_w)/2" "$row_target" "$box"
  panel_add notice.txt "$UI_SIZE_TOP" "$UI_COLOR_MUTED" "(w-text_w)/2" "$row_notice" "$box"
  if [ "$UI_DONATE" = 1 ]; then
    panel_add last.txt "$UI_SIZE_LAST" "$UI_COLOR_TEXT" "(w-text_w)/2" "h-$row_last" "$box"
    panel_add menu.txt "$UI_SIZE_MENU" "$UI_COLOR_MUTED" "(w-text_w)/2" "h-${UI_BOTTOM}" "$box"
  fi
  log "ui: $UI_DIR, ${PANEL_LAYERS} drawtext layers, bar ${UI_SIZE_BAR}px at ${UI_MARGIN}px margin,"\
" donation lines $([ "$UI_DONATE" = 1 ] && echo on || echo off)"
}

# The panel carries the donation lines itself, so the single-block overlay above is used only when
# the panel is off - otherwise every donation would be printed twice.
panel_setup
if [ "$PANEL_LAYERS" -gt 0 ]; then
  VF="${VF}${PANEL_VF}"
else
  VF="${VF}${OVERLAY_VF:-}"
fi

# The encoder starts a second after this container, the panel appears once the control API has
# polled the game. Waiting here is cheaper than restarting the encoder: the first frames of the
# stream then already carry the panel instead of a bare game.
#
# The marker is `ui.json`, not one of the lines: the control API writes the lines first and the dump
# last, and a drawtext filter whose text file does not exist yet fails the whole graph.
wait_for_panel() {
  [ "$PANEL_LAYERS" -gt 0 ] || return 0
  local waited=0
  while [ "$waited" -lt 20 ]; do
    if [ -f "$UI_DIR/$UI_READY" ]; then
      log "ui: panel ready after ${waited}s"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  log "ui: nothing in $UI_DIR after 20s, the lines stay empty until the control API writes them"
  return 0
}

# --- output -----------------------------------------------------------------------------------
# The container format follows the scheme of the target, never a separate setting: an RTMP server
# rejects anything that is not FLV, while a file must not get the FLV wrapper.
RECORD_SEC="${STREAM_RECORD_SEC:-0}"
case "$RECORD_SEC" in ''|*[!0-9]*) log "STREAM_RECORD_SEC must be an integer"; exit 2 ;; esac
WARMUP="${STREAM_WARMUP_SEC:-25}"
if [ -n "${STREAM_OUTPUT:-}" ]; then
  TARGET="$STREAM_OUTPUT"
  case "$TARGET" in
    rtmp://*|rtmps://*)        TARGET_FORMAT=flv ;     TARGET_KIND=rtmp ;;
    tcp://*|udp://*|srt://*)   TARGET_FORMAT=mpegts ;  TARGET_KIND=mpegts ;;
    *://*) log "unsupported scheme in STREAM_OUTPUT: $TARGET (rtmp, tcp, udp, srt or a file path)"; exit 2 ;;
    *)                     TARGET_FORMAT=matroska ; TARGET_KIND=file ;;
  esac
  TARGET_LABEL="$TARGET"
else
  : "${YOUTUBE_STREAM_KEY:?YOUTUBE_STREAM_KEY is required (YouTube Studio -> Go live -> stream key), or set STREAM_OUTPUT to record locally or to push to a local hub}"
  TARGET="${RTMP_BASE}/${YOUTUBE_STREAM_KEY}"
  TARGET_FORMAT=flv
  TARGET_KIND=rtmp
  TARGET_LABEL="${RTMP_BASE} (key hidden)"
  RECORD_SEC=0
fi

# GoldSrc `connect` takes an address, not a host name: it does no DNS lookup, so `connect srv:27015`
# fails silently in a container network. Resolving here also keeps the rest of the script simple.
resolve_server_addr() {
  local host="${SERVER_ADDR%:*}" port="${SERVER_ADDR##*:}" ip
  case "$host" in
    ''|*[!0-9.]*) ;;
    *) return 0 ;;   # already an IPv4 literal
  esac
  ip=$(getent hosts "$host" 2>/dev/null | awk 'NR==1 { print $1 }')
  if [ -n "$ip" ]; then
    log "resolved $host -> $ip"
    SERVER_ADDR="$ip:$port"
  else
    log "warning: could not resolve $host, keeping it as is"
  fi
}

# The engine looks for valve/ and cstrike/ next to its own binary, so both the assets and the
# engine live in GAME_DIR. Copying the assets happens once per volume, not on every restart.
#
# tar instead of cp -a: the server volume also holds files this user must not read (server.cfg is
# 0600 because it carries rcon_password, and the server writes 0600 logs). Those are excluded, and
# --ignore-failed-read keeps an unexpected one from aborting the whole copy.
copy_tree() {
  local d="$1"
  mkdir -p "$GAME_DIR/$d" || return 1
  ( cd "$SERVER_DIR/$d" && tar --ignore-failed-read \
      --exclude=logs --exclude=server.cfg --exclude='*.log' --exclude='*.mdmp' -cf - . ) |
    tar -xf - -C "$GAME_DIR/$d" || { log "copy of $d failed"; return 1; }
}

# A map added to the server after the first run (or the .wad that came with it) is not in the client
# volume yet, and CS16Client cannot join a map it does not have: the stream would break on exactly
# the map change a donation paid for. --skip-old-files makes this a stat per file, not a copy.
sync_new_files() {
  local d="$1"
  ( cd "$SERVER_DIR/$d" && tar --ignore-failed-read \
      --exclude=logs --exclude=server.cfg --exclude='*.log' --exclude='*.mdmp' -cf - . ) |
    tar -xf - -C "$GAME_DIR/$d" --skip-old-files || { log "sync of $d failed"; return 1; }
}

prepare_game_dir() {
  mkdir -p "$GAME_DIR"
  local d
  for d in valve cstrike; do
    if [ ! -d "$GAME_DIR/$d" ]; then
      log "first run: copying $d from $SERVER_DIR (one-time, ~1 min)"
      copy_tree "$d" || return 1
    else
      sync_new_files "$d" || return 1
    fi
  done
  # Engine + bundled SDL2/ffmpeg libraries must sit in the same directory as the game dirs.
  cp -a /opt/xash/. "$GAME_DIR/" || { log "engine copy failed"; return 1; }
  # Valve's client library needs a Steam session; CS16Client's open-source one does not.
  cp -a /opt/cs16client/cstrike/cl_dlls/. "$GAME_DIR/cstrike/cl_dlls/" || { log "client library copy failed"; return 1; }
  cp -a /opt/cs16client/cstrike/extras.pk3 "$GAME_DIR/cstrike/extras.pk3" || { log "extras.pk3 copy failed"; return 1; }
  log "game dir ready: $(du -sh "$GAME_DIR" | cut -f1)"
}

start_x() {
  rm -f /tmp/.X99-lock
  Xvfb :99 -screen 0 "${CAP_W}x${CAP_H}x24" -nolisten tcp > /tmp/xvfb.log 2>&1 &
  local i
  for i in $(seq 1 30); do
    if xdpyinfo -display :99 > /dev/null 2>&1; then
      log "Xvfb up at ${CAP_W}x${CAP_H}"
      return 0
    fi
    sleep 1
  done
  log "Xvfb did not start: $(tail -3 /tmp/xvfb.log)"
  return 1
}

# The client joins through cstrike/userconfig.cfg, not through `+connect`:
#
# - `+connect`, `-connect` and a `connect` line in config.cfg are all dropped, because Xash3D
#   queues `+`-commands and the config file during Host_Init, before CL_Init - the network stack
#   does not exist yet, so the command is executed into nothing and the client stays in the menu.
# - `wait` is a real Cbuf command: it splits the buffer and resumes the remainder on a later
#   frame. A chain of waits therefore defers `connect` until the client is initialised, which is
#   exactly why typing the same command into the console (after init) always worked.
# - userconfig.cfg and not config.cfg: the engine rewrites config.cfg on exit, so anything kept
#   there disappears after the first shutdown.
write_client_config() {
  local cfg="$GAME_DIR/cstrike/userconfig.cfg" i
  {
    echo "// generated by stream-entrypoint.sh: deferred join, see the comment there"
    echo "name \"$PLAYER_NAME\""
    # GoldSrc mixes at full scale and clips into the capture: peaks measured at +8 dB. Lowering the
    # client volume is the only place where this can be fixed without distorting the stream.
    echo "volume ${STREAM_GAME_VOLUME:-0.6}"
    # The weapon in first person is a client-side view model: the server cannot draw one it never
    # sent, so the client at least has to keep drawing "v_" models.
    echo "r_drawviewmodel 1"
    echo "cl_righthand 1"
    # The spectator overlay is drawn by the client in code: the VGUI resources under
    # cstrike/resource/UI are never read by CS16Client - there is not a single "resource/UI" string in
    # client.so or menu.so - so editing Spectator.res does nothing. These cvars empty the bands
    # (scores, map, round timer, view cone). The translucent background of the bands has no switch at
    # all, the encoder cuts it off instead (STREAM_BAND_PERCENT in the filter chain above).
    echo "spec_drawstatus 0"
    echo "spec_drawnames 0"
    echo "spec_drawcone 0"
    echo "spec_decal 0"
    # `hud_draw 0` removes the translucent bars completely (they are painted by the client HUD), but it
    # takes the whole HUD with them: health, armour, ammo, radar, kill feed and our own hudmessage. That
    # was tried and rejected - the HUD is what makes the picture readable as a game. With these cvars
    # the bands lose their content, and the encoder takes care of the background.
    for i in $(seq 1 400); do echo "wait"; done
    echo "connect $SERVER_ADDR"
    # the team menu is open after the join; 6 = Spectator
    for i in $(seq 1 200); do echo "wait"; done
    echo "jointeam 6"
    for i in $(seq 1 60); do echo "wait"; done
    echo "spec_mode $SPEC_MODE"
    # `wait` counts frames and the engine runs at fps_max = FPS, so SEC*FPS waits is about SEC
    # seconds. Each step switches to the next player; off by default, because the server plugin
    # (plugins/stream_cam) drives the camera and two directors fight each other.
    if [ "$SPEC_SWITCH_SEC" -gt 0 ]; then
      local frames=$(( SPEC_SWITCH_SEC * FPS )) n
      for n in $(seq 1 20); do
        for i in $(seq 1 "$frames"); do echo "wait"; done
        echo "spec_next"
      done
    fi
  } > "$cfg" || { log "could not write $cfg"; return 1; }
  log "client config written: $cfg ($(wc -l < "$cfg") lines)"
}

# A container has no sound card. PulseAudio with a null sink gives the engine somewhere to play and
# gives ffmpeg a `.monitor` source to record, which is how in-game sound reaches the stream. Without
# it the encoder falls back to a silent AAC track: YouTube dislikes video-only live streams.
start_audio() {
  # The bundled SDL2 has no pulse backend, so SDL is told to use ALSA and /etc/asound.conf routes
  # ALSA to PulseAudio; SDL_AUDIODRIVER=dummy from the Dockerfile must be overridden here.
  export SDL_AUDIODRIVER=alsa
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg}"
  mkdir -p "$XDG_RUNTIME_DIR" 2>/dev/null
  PULSE_MONITOR="${PULSE_MONITOR:-cs.monitor}"
  pulseaudio --start --exit-idle-time=-1 --log-target=file:/tmp/pulse.log > /dev/null 2>&1
  local i
  for i in $(seq 1 20); do
    pactl info > /dev/null 2>&1 && break
    sleep 0.5
  done
  if ! pactl info > /dev/null 2>&1; then
    log "pulseaudio did not start, the stream will have no game sound: $(tail -2 /tmp/pulse.log 2>/dev/null)"
    AUDIO_OK=0
    return 1
  fi
  pactl load-module module-null-sink sink_name=cs sink_properties=device.description=CS > /dev/null 2>&1
  pactl set-default-sink cs > /dev/null 2>&1
  # An idle null sink gets suspended by module-suspend-on-idle, and a suspended monitor delivers no
  # packets at all. ffmpeg then waits for its audio input, never writes the FLV header, and the RTMP
  # server closes an idle publisher after its read timeout. Dropping the module keeps silence
  # flowing from the first second, before the engine has even opened its audio stream.
  pactl unload-module module-suspend-on-idle > /dev/null 2>&1
  AUDIO_OK=1
  log "audio ready: null sink 'cs', capturing $PULSE_MONITOR"
  return 0
}

run_client() {
  # The loader resolves libxash.so through $ORIGIN, but an explicit path also covers the case
  # where the engine files were copied next to the game dirs. Never add the HLDS copies of
  # libsteam_api.so/libgcc_s.so.1 here: they are older than the system ones and break the loader.
  export LD_LIBRARY_PATH="$GAME_DIR"
  export XASH3D_BASEDIR="$GAME_DIR"
  export XASH3D_EXTRAS_PAK1="$GAME_DIR/valve/extras.pk3"
  export DISPLAY="${DISPLAY:-:99}"
  local -a sound=()
  [ "${AUDIO_OK:-0}" = 1 ] || sound=(-nosound)
  while true; do
    log "starting engine, it joins $SERVER_ADDR from userconfig.cfg"
    # -dev is what makes the engine print connection events to stdout; watchdog.sh reads them to
    # detect a drop (there is no other way to ask this client whether it is still on the server).
    # The log is truncated on every start so old disconnects cannot be mistaken for new ones.
    : > /tmp/xash.log
    "$GAME_DIR/xash3d" -ref gl -game cstrike \
      -windowed -width "$CAP_W" -height "$CAP_H" \
      "${sound[@]}" -nojoy -dev +fps_max "$FPS" \
      >> /tmp/xash.log 2>&1
    log "engine exited ($?), restarting in 5s; last lines:"
    sed 's/\x1b\[[0-9;]*m//g' /tmp/xash.log | tail -5
    sleep 5
  done
}

run_encoder() {
  local -a args=(
    -hide_banner -loglevel "${STREAM_FFMPEG_LOGLEVEL:-warning}" -nostdin -y
    # thread_queue_size: X11 and PulseAudio are not pulled by ffmpeg, they push; without a queue
    # ffmpeg logs "Thread message queue blocking" and starts dropping frames on a busy CPU.
    # analyzeduration/probesize are pinned to zero because both inputs are raw: the default five
    # seconds of probing delay the first packet past MediaMTX's 10 s publisher read timeout, and
    # the push dies with "Broken pipe" before a single frame is sent.
    -thread_queue_size 512 -analyzeduration 0 -probesize 32
    -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${CAP_W}x${CAP_H}" -i ":99.0"
  )
  local audio_filter=""
  if [ "${AUDIO_OK:-0}" = 1 ]; then
    args+=(-thread_queue_size 512 -analyzeduration 0 -probesize 32 -f pulse -i "$PULSE_MONITOR")
    # PulseAudio timestamps drift against the X11 clock; without this ffmpeg prints
    # "Non-monotonic DTS" and the audio stutters in the final file.
    # alimiter must run with level=false: its default auto-level applies makeup gain and the
    # recording ended up 6 dB over full scale even though the limiter was in the chain.
    # Two inputs (X11 + PulseAudio) and the engine can scream: attenuate first, then limit.
    #
    # Kept in a variable and appended after every input: `-af` is an output option, and between two
    # `-i` arguments ffmpeg reads it as an input option for the next file ("Option af ... cannot be
    # applied to input url").
    audio_filter="aresample=async=1:first_pts=0,volume=-8dB,alimiter=limit=0.95:level=false"
  else
    # A video-only stream is flagged by YouTube; silence still gives it an audio track.
    args+=(-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100")
  fi
  # The panel is part of VF: every line is a drawtext filter fed by its own text file, so there is
  # no second input to keep in sync with the game frame.
  args+=(-vf "$VF")
  if [ -n "$audio_filter" ]; then args+=(-af "$audio_filter"); fi
  args+=(
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -threads "$ENC_THREADS"
    -b:v "${BITRATE}k" -maxrate "${BITRATE}k" -bufsize "$((BITRATE * 2))k"
    -g "$((FPS * 2))" -keyint_min "$FPS" -sc_threshold 0
    -c:a aac -b:a 128k -shortest
  )
  if [ "$RECORD_SEC" -gt 0 ]; then args+=(-t "$RECORD_SEC"); fi
  # A TCP receiver connects to us, so ffmpeg has to listen; anything else dials the peer.
  case "$TARGET" in tcp://*) args+=(-listen 1) ;; esac
  args+=(-f "$TARGET_FORMAT" "$TARGET")
  log "ffmpeg <- ${OUT_W}x${OUT_H}@${FPS}, capture ${CAP_W}x${CAP_H}, game ${GAME_W}x${GAME_H} at y=${PAD_Y}, panel=${PANEL_LAYERS} layers, ${BITRATE}k -> $TARGET_LABEL"
  # The command itself is logged without the last two arguments: for RTMP they hold the stream key.
  log "ffmpeg args: ${args[*]:0:${#args[@]}-2}"
  # ffmpeg writes its stderr to a file, never into a pipe: with a process substitution (or any pipe
  # whose reader runs in this shell) the encoder stalled right after the FLV header — two frames in
  # ten seconds, then the RTMP server dropped the idle publisher. The metrics tap below reads the
  # same file and forwards it to the container log, so nothing is lost.
  ffmpeg "${args[@]}" 2>> /tmp/ffmpeg.log
}

# Tails the encoder log: copies every line to the container log, so `docker logs` still shows what
# ffmpeg says while the encoder itself never writes into a pipe. Separate process on purpose.
# ffmpeg prints the publish URL in its errors ("Error opening output rtmps://.../<key>"), so the
# stream key is masked on the way out: the Docker log is the one place the key must never appear.
start_metrics_tap() {
  : > /tmp/ffmpeg.log
  ( tail -F -n 0 /tmp/ffmpeg.log 2>/dev/null | mask_stream_key ) &
}

# sed replacement pattern for the key: a plain substitution, no group or alternation, so it cannot
# fail on a regex dialect. The key is [a-z0-9-] only and unique per broadcast, so a global replace
# of that literal string is enough. Falls back to cat when there is no key (local pushes).
mask_stream_key() {
  if [ -n "${YOUTUBE_STREAM_KEY:-}" ]; then
    sed -u "s/${YOUTUBE_STREAM_KEY}/***/g"
  else
    cat
  fi
}

# What the encoder is doing right now, readable by the control API through the shared volume.
# Written before the encoder starts so the UI never sees a stale layout from an earlier run.
write_stream_status() {
  mkdir -p "$STATUS_DIR" 2>/dev/null || { log "cannot create $STATUS_DIR, the admin UI will not see the stream"; return 0; }
  printf '{"kind":"%s","label":"%s","width":%s,"height":%s,"captureWidth":%s,"captureHeight":%s,"fps":%s,"bitrateKbps":%s,"recordSec":%s,"audio":%s,"startedAt":"%s"}\n' \
    "$TARGET_KIND" "${TARGET_LABEL//\"/}" "$OUT_W" "$OUT_H" "$CAP_W" "$CAP_H" "$FPS" "$BITRATE" "$RECORD_SEC" \
    "$([ "${AUDIO_OK:-0}" = 1 ] && echo true || echo false)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$STATUS_DIR/status.json" 2>/dev/null || log "cannot write $STATUS_DIR/status.json"
  : > "$STATUS_DIR/progress.txt" 2>/dev/null
}

# An RTMP server drops a publisher that sends nothing for its read timeout (MediaMTX: 10 s), and
# ffmpeg writes the FLV header only after it has probed every input. The PulseAudio monitor is
# silent until the engine actually plays, so a push started before the client joins dies with
# "Broken pipe" while the local recording of the same command works. Waiting for the join line in
# the client log is the cheapest reliable fix: the string is printed by the engine on connect.
wait_for_client() {
  local waited=0
  while [ "$waited" -lt "$JOIN_TIMEOUT" ]; do
    # The engine prints this when it starts the handshake; "entered the game" comes from the game
    # server, not from the client log, so it is useless here.
    if grep -qa 'Trying to connect with GoldSrc\|Server IPv4 address' /tmp/xash.log 2>/dev/null; then
      # Connecting is not playing: the map still has to load and the engine has to open its audio
      # stream. Starting the encoder before that leaves a silent audio input, which is exactly the
      # case that used to time out.
      log "client connected after ${waited}s, settling ${JOIN_SETTLE}s"
      sleep "$JOIN_SETTLE"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "client did not connect within ${JOIN_TIMEOUT}s, starting the encoder anyway"
  return 1
}

# The client draws the CS "SELECT TEAM" VGUI panel over the game, and no console command closes it:
# `jointeam`, `menuselect` and `cancelselect` are ignored, and commands arriving from the server are
# rejected outright (`Could not execute privileged command`). The panel is hidden only by the
# client's own VGUI code, so the key is pressed for real through X11, exactly like a human would:
# 6 = SPECTATE in the CS 1.6 team menu.
press_team_key() {
  command -v xdotool > /dev/null 2>&1 || { log "xdotool is missing, the team panel may stay on screen"; return 0; }
  # Without a window manager the X focus is PointerRoot, so the pointer has to be over the client
  # window for the key event to reach it.
  DISPLAY="$DISPLAY" xdotool mousemove 480 360 2>/dev/null || true
  DISPLAY="$DISPLAY" xdotool key --clearmodifiers 6 2>/dev/null || log "xdotool could not send the key"
  log "sent key 6 (SPECTATE) to the client window"
}

# The panel can appear several seconds after the join (and again after every reconnect), so the key
# is pressed often for the first minute and then rarely, forever: this loop must never exit, because
# the entrypoint stops the whole container when any child process ends (`wait -n`).
press_team_key_loop() {
  local waited=0
  while true; do
    press_team_key
    if [ "$waited" -lt 60 ]; then
      sleep 5
      waited=$((waited + 5))
    else
      sleep 60
    fi
  done
}

# A harder, measured version of the same problem: the engine opens its audio stream long before it
# plays anything (map load on llvmpipe takes ~20-30 s), and a sink-input alone proves nothing —
# ffmpeg then waits for the first audio packet, never writes the FLV header, and the RTMP server
# drops the publisher after its read timeout. So the test is actual data: one second of the monitor
# source must deliver bytes. If it never does, the stream degrades to silence instead of dying.
wait_for_audio() {
  [ "${AUDIO_OK:-0}" = 1 ] || return 1
  local waited=0
  while [ "$waited" -lt "$AUDIO_TIMEOUT" ]; do
    # 1 s of 48 kHz stereo PCM is ~192 KB when the sink is running; an idle sink delivers nothing.
    timeout 2 parec --device="$PULSE_MONITOR" --format=s16le --rate=48000 --channels=2 \
      > /tmp/audio-probe.raw 2>/dev/null
    if [ -s /tmp/audio-probe.raw ]; then
      log "engine audio is flowing after ${waited}s ($(wc -c < /tmp/audio-probe.raw) bytes/s)"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "engine never produced audio within ${AUDIO_TIMEOUT}s: the stream will carry silence"
  AUDIO_OK=0
  return 1
}

# Until the map is loaded the X server is busy serving the engine, and x11grab can return no frames
# at all for the first seconds: the FLV header is never written and the RTMP server drops the idle
# publisher. Waiting for the "right" moment is guesswork, so the encoder is supervised instead: a
# failed attempt costs one retry, not the whole stream. This is also what YouTube needs — a dropped
# publisher must come back on its own, without a human restarting a container.
run_encoder_forever() {
  local attempt=0 delay
  while true; do
    attempt=$((attempt + 1))
    log "encoder attempt ${attempt}"
    run_encoder
    local code=$?
    if [ "$RECORD_SEC" -gt 0 ]; then
      log "encoder finished ($code)"
      return "$code"
    fi
    delay=$(( attempt < 5 ? 5 : 15 ))
    log "encoder exited ($code), retrying in ${delay}s"
    sleep "$delay"
  done
}

prepare_game_dir || exit 1
resolve_server_addr
write_client_config || exit 1
start_x || exit 1
# Sound is optional: a broken PulseAudio must not stop the picture.
start_audio || true
write_stream_status

run_client &

# The client window only exists once the engine is up, and the team panel appears a few seconds after
# the join: start pressing early and keep going for the first minute (see press_team_key).
press_team_key_loop &

# The encoder writes its stderr to a file; this tap turns it back into container logs plus telemetry.
start_metrics_tap

# The encoder must not start before the client is actually in the game: see wait_for_client().
wait_for_client || true
# ...and before the engine produces audio: see wait_for_audio().
wait_for_audio || true

# A timed run is a one-shot: capture for STREAM_RECORD_SEC and leave. The extra warm-up sleep is
# kept for the case where the join line appears long before the first frame is rendered.
if [ "$RECORD_SEC" -gt 0 ]; then
  log "warm-up ${WARMUP}s before capturing ${RECORD_SEC}s -> $TARGET_LABEL"
  sleep "$WARMUP"
  run_encoder
  log "ffmpeg exited ($?)"
  if [ "$TARGET_KIND" = file ]; then
    if [ -f "$TARGET" ]; then log "recorded $(du -h "$TARGET" | cut -f1) -> $TARGET"; else log "no file produced at $TARGET"; fi
  fi
  # `kill 0` would take the whole process group including this shell, leaving exit code 143;
  # a timed run is a success, so kill the children and exit cleanly.
  kill $(jobs -p) 2>/dev/null
  exit 0
fi

# The control API writes the panel files; the encoder starts once the first one exists, so the first
# frames of the stream already carry the interface instead of a bare game.
wait_for_panel
run_encoder_forever &
# The watchdog needs the layout to sample the same framebuffer ffmpeg grabs, and STATUS_DIR to write
# its heartbeat next to status.json.
STATUS_DIR="$STATUS_DIR" CAP_W="$CAP_W" CAP_H="$CAP_H" DISPLAY="$DISPLAY" /usr/local/bin/watchdog.sh &

# tini forwards SIGTERM; keep the container alive while either loop is running.
wait -n
log "a child exited, stopping"
kill 0
