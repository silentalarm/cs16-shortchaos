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
#   empty STREAM_OUTPUT - push to RTMP, YOUTUBE_STREAM_KEY is required;
#   STREAM_OUTPUT=path  - record to that file for STREAM_RECORD_SEC seconds and exit, so the
#                         picture can be reviewed without going live and without a stream key.
set -uo pipefail

GAME_DIR="${GAME_DIR:-/game}"
SERVER_DIR="${SERVER_DIR:-/server}"
SERVER_ADDR="${SERVER_ADDR:-127.0.0.1:27015}"
FPS="${STREAM_FPS:-30}"
BITRATE="${STREAM_BITRATE_KBPS:-2000}"
RTMP_BASE="${STREAM_RTMP:-rtmp://a.rtmp.youtube.com/live2}"
PLAYER_NAME="${STREAM_CAM_NAME:-StreamCam}"

# Spectator camera. 4 = OBS_IN_EYE (through the followed player's eyes); 6 is OBS_MAP_CHASE, which
# is the map overview the first recording showed. spec_next is the only client-side way to move
# between players, so the generated config cycles through them on a timer.
SPEC_MODE="${STREAM_SPEC_MODE:-4}"
SPEC_SWITCH_SEC="${STREAM_SPEC_SWITCH_SEC:-6}"

log() { printf '%s [stream] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# --- layout -----------------------------------------------------------------------------------
# ORIENTATION sets the default canvas and render size; every value can be overridden, the defaults
# are the ones that fit a small VPS: 720x1280 encodes in about 0.7 of a core, 1080x1920 needs 1.5.
ORIENTATION="${STREAM_ORIENTATION:-vertical}"
case "$ORIENTATION" in
  vertical)   DEF_OUT_W=720;  DEF_OUT_H=1280; DEF_CAP_W=960;  DEF_CAP_H=720; TOP=140 ;;
  horizontal) DEF_OUT_W=1280; DEF_OUT_H=720;  DEF_CAP_W=1280; DEF_CAP_H=720; TOP=0   ;;
  *) log "STREAM_ORIENTATION must be vertical or horizontal, got '$ORIENTATION'"; exit 2 ;;
esac
OUT_W="${STREAM_WIDTH:-$DEF_OUT_W}"
OUT_H="${STREAM_HEIGHT:-$DEF_OUT_H}"
CAP_W="${STREAM_CAPTURE_WIDTH:-$DEF_CAP_W}"
CAP_H="${STREAM_CAPTURE_HEIGHT:-$DEF_CAP_H}"

for v in "$OUT_W" "$OUT_H" "$CAP_W" "$CAP_H"; do
  case "$v" in ''|*[!0-9]*) log "resolution values must be integers"; exit 2 ;; esac
  (( v % 2 )) && { log "resolution values must be even for yuv420p, got $v"; exit 2; }
done

# Fit the captured frame into the canvas by width, then place it at TOP. yuv420p requires even
# numbers everywhere: an odd size makes libx264 fail with a cryptic "width not divisible by 2".
GAME_W=$OUT_W
GAME_H=$(( OUT_W * CAP_H / CAP_W ))
(( GAME_H % 2 )) && GAME_H=$(( GAME_H - 1 ))
(( GAME_H > OUT_H )) && GAME_H=$OUT_H
PAD_Y=$TOP
(( PAD_Y % 2 )) && PAD_Y=$(( PAD_Y - 1 ))
(( PAD_Y + GAME_H > OUT_H )) && PAD_Y=$(( (OUT_H - GAME_H) / 2 ))
(( PAD_Y < 0 )) && PAD_Y=0
VF="scale=${GAME_W}:${GAME_H}:flags=bicubic"
if [ "$GAME_H" -ne "$OUT_H" ] || [ "$GAME_W" -ne "$OUT_W" ]; then
  VF="${VF},pad=${OUT_W}:${OUT_H}:0:${PAD_Y}:color=0x101014"
fi
VF="${VF},format=yuv420p"

# --- output -----------------------------------------------------------------------------------
RECORD_SEC="${STREAM_RECORD_SEC:-0}"
case "$RECORD_SEC" in ''|*[!0-9]*) log "STREAM_RECORD_SEC must be an integer"; exit 2 ;; esac
WARMUP="${STREAM_WARMUP_SEC:-25}"
if [ -n "${STREAM_OUTPUT:-}" ]; then
  TARGET="$STREAM_OUTPUT"
  TARGET_FORMAT=matroska
  TARGET_LABEL="file:$STREAM_OUTPUT"
else
  : "${YOUTUBE_STREAM_KEY:?YOUTUBE_STREAM_KEY is required (YouTube Studio -> Go live -> stream key), or set STREAM_OUTPUT to record locally}"
  TARGET="${RTMP_BASE}/${YOUTUBE_STREAM_KEY}"
  TARGET_FORMAT=flv
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

prepare_game_dir() {
  mkdir -p "$GAME_DIR"
  local d
  for d in valve cstrike; do
    if [ ! -d "$GAME_DIR/$d" ]; then
      log "first run: copying $d from $SERVER_DIR (one-time, ~1 min)"
      copy_tree "$d" || return 1
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
    for i in $(seq 1 400); do echo "wait"; done
    echo "connect $SERVER_ADDR"
    # the team menu is open after the join; 6 = Spectator
    for i in $(seq 1 200); do echo "wait"; done
    echo "jointeam 6"
    for i in $(seq 1 60); do echo "wait"; done
    echo "spec_mode $SPEC_MODE"
    # `wait` counts frames and the engine runs at fps_max = FPS, so SEC*FPS waits is about SEC
    # seconds. Each step switches to the next player, otherwise the camera sits on one bot forever.
    local frames=$(( SPEC_SWITCH_SEC * FPS )) n
    for n in $(seq 1 20); do
      for i in $(seq 1 "$frames"); do echo "wait"; done
      echo "spec_next"
    done
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
    -hide_banner -loglevel warning -nostdin -y
    -f x11grab -draw_mouse 0 -framerate "$FPS" -video_size "${CAP_W}x${CAP_H}" -i ":99.0"
  )
  if [ "${AUDIO_OK:-0}" = 1 ]; then
    args+=(-f pulse -i "$PULSE_MONITOR")
    # PulseAudio timestamps drift against the X11 clock; without this ffmpeg prints
    # "Non-monotonic DTS" and the audio stutters in the final file.
    # alimiter must run with level=false: its default auto-level applies makeup gain and the
    # recording ended up 6 dB over full scale even though the limiter was in the chain.
    # Two inputs (X11 + PulseAudio) and the engine can scream: attenuate first, then limit.
    args+=(-af "aresample=async=1:first_pts=0,volume=-8dB,alimiter=limit=0.95:level=false")
  else
    # A video-only stream is flagged by YouTube; silence still gives it an audio track.
    args+=(-f lavfi -i "anullsrc=channel_layout=stereo:sample_rate=44100")
  fi
  args+=(
    -vf "$VF"
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p
    -b:v "${BITRATE}k" -maxrate "${BITRATE}k" -bufsize "$((BITRATE * 2))k"
    -g "$((FPS * 2))" -keyint_min "$FPS" -sc_threshold 0
    -c:a aac -b:a 128k -shortest
  )
  if [ "$RECORD_SEC" -gt 0 ]; then args+=(-t "$RECORD_SEC"); fi
  args+=(-f "$TARGET_FORMAT" "$TARGET")
  log "ffmpeg <- ${OUT_W}x${OUT_H}@${FPS}, capture ${CAP_W}x${CAP_H}, game ${GAME_W}x${GAME_H} at y=${PAD_Y}, ${BITRATE}k -> $TARGET_LABEL"
  # The command itself is logged without the last two arguments: for RTMP they hold the stream key.
  log "ffmpeg args: ${args[*]:0:${#args[@]}-2}"
  ffmpeg "${args[@]}"
}

prepare_game_dir || exit 1
resolve_server_addr
write_client_config || exit 1
start_x || exit 1
# Sound is optional: a broken PulseAudio must not stop the picture.
start_audio || true

run_client &

# A recording run is a one-shot: warm the client up so the capture is not a menu screen, film for
# STREAM_RECORD_SEC and leave. The client is started anyway, otherwise there is nothing to watch.
if [ "$RECORD_SEC" -gt 0 ]; then
  log "warm-up ${WARMUP}s before recording ${RECORD_SEC}s"
  sleep "$WARMUP"
  run_encoder
  log "ffmpeg exited ($?)"
  if [ -f "$TARGET" ]; then log "recorded $(du -h "$TARGET" | cut -f1) -> $TARGET"; else log "no file produced at $TARGET"; fi
  # `kill 0` would take the whole process group including this shell, leaving exit code 143;
  # a recording run is a success, so kill the children and exit cleanly.
  kill $(jobs -p) 2>/dev/null
  exit 0
fi

run_encoder &
/usr/local/bin/watchdog.sh &

# tini forwards SIGTERM; keep the container alive while either loop is running.
wait -n
log "a child exited, stopping"
kill 0