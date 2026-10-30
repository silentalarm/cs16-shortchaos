#!/bin/sh
# Plays what the control API leaves in the voice directory: speech, effect cues and event music.
#
# Why here and not in the game: a GoldSrc sound only reaches a client if it was precached, so every
# new line of speech or custom cue would need a file inside the game client. This container already
# owns the audio the broadcast carries - ffmpeg records the PulseAudio null sink `cs` - so text is
# synthesised with espeak-ng and files are played straight into that sink.
#
# A request is a small line-based text file:
#   voice=<espeak voice|->      text=<line>
#   file=<path>                 a one-shot sound effect
#   music=<code|path>           bed music; `seconds` cuts it when the event clock runs out
#   seconds=<n>                 playback window for music
#   musicStop=1                 cut the bed and keep everything else (an event that starts no bed)
#   stop=1                      silence everything (the panel's Stop button)
#
# Music is backgrounded, so the spoken announcement still plays over it, and a new request kills the
# previous bed: one event in the frame means one bed in the mix. A cue (`file=`) is backgrounded the
# same way and tracked by its own pid: the `red_light` phases arrive 1.5-2 s apart, so playing them
# one after another inside this loop would drift away from the game's own freeze/thaw. A marker per
# played request is what makes "played once" true - the overlay volume is mounted read-only here, so
# `rm` cannot be relied on.
set -u

VOICE_DIR="${VOICE_DIR:-/overlay/voice}"
SINK="${SINK:-cs}"
POLL_SEC="${POLL_SEC:-0.3}"
SEEN_DIR="${SEEN_DIR:-/tmp/voice-seen}"
# Overlay first: a real track dropped into the volume wins over the one baked into the image.
MUSIC_DIRS="${MUSIC_DIRS:-/overlay/music /usr/share/cs16/music}"
MUSIC_PID_FILE="${MUSIC_PID_FILE:-/tmp/voice-music.pid}"
# One cue at a time: a phase cue replaces the previous one, so two files never talk over each other
# whatever their length is.
CUE_PID_FILE="${CUE_PID_FILE:-/tmp/voice-cue.pid}"
# The overlay volume is read-only here, so played requests cannot be deleted and the markers live in
# /tmp, which a restart clears. Replaying the last two minutes of announcements after a restart is
# exactly what this age check prevents: a request older than this is history, not a command.
MAX_AGE_SEC="${MAX_AGE_SEC:-30}"

log() { echo "[voice] $*"; }

mkdir -p "$VOICE_DIR" 2>/dev/null || true
mkdir -p "$SEEN_DIR" 2>/dev/null || true

if command -v espeak-ng >/dev/null 2>&1; then
  log "engine: espeak-ng, dir $VOICE_DIR, sink $SINK"
else
  log "espeak-ng is missing: speech requests will be dropped"
fi

stop_music() {
  [ -f "$MUSIC_PID_FILE" ] || return 0
  pid=$(cat "$MUSIC_PID_FILE" 2>/dev/null || true)
  if [ -n "${pid:-}" ]; then
    kill "$pid" 2>/dev/null || true
    log "music stopped"
  fi
  rm -f "$MUSIC_PID_FILE" 2>/dev/null || true
}

# The cue channel: a backgrounded one-shot, replaced by the next cue. Phase cues are the case it
# exists for - RED and GREEN are 1.5 s and 2 s apart, and blocking the poll loop on a one-second file
# would put every following cue behind the game's own freeze/thaw.
stop_cue() {
  [ -f "$CUE_PID_FILE" ] || return 0
  pid=$(cat "$CUE_PID_FILE" 2>/dev/null || true)
  if [ -n "${pid:-}" ]; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$CUE_PID_FILE" 2>/dev/null || true
}

# start_cue <path>
start_cue() {
  stop_cue
  paplay --device="$SINK" "$1" >/dev/null 2>&1 &
  printf '%s' "$!" > "$CUE_PID_FILE"
  log "cue: $(basename "$1")"
}

# A code resolves to the overlay copy first, then to the baked one; an absolute path is taken as-is.
music_file() {
  case "$1" in
    /*) if [ -f "$1" ]; then printf '%s' "$1"; return 0; fi ;;
  esac
  for dir in $MUSIC_DIRS; do
    if [ -f "$dir/$1.wav" ]; then
      printf '%s' "$dir/$1.wav"
      return 0
    fi
  done
  return 1
}

# start_music <code|path> <seconds>
start_music() {
  stop_music
  if ! path=$(music_file "$1"); then
    log "no music for $1"
    return 0
  fi

  paplay --device="$SINK" "$path" >/dev/null 2>&1 &
  pid=$!
  printf '%s' "$pid" > "$MUSIC_PID_FILE"
  log "music: $(basename "$path") for ${2}s"

  # The cut is the point: the bed must end with the event, whatever the file length is.
  (
    sleep "$2"
    current=$(cat "$MUSIC_PID_FILE" 2>/dev/null || true)
    if [ "$current" = "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      rm -f "$MUSIC_PID_FILE" 2>/dev/null || true
      log "music ended with the event (${2}s)"
    fi
  ) &
}

while :; do
  handled=0
  for request in "$VOICE_DIR"/*.req; do
    [ -f "$request" ] || continue

    name=$(basename "$request")
    # A played request keeps its file - this container cannot delete from the overlay volume, the
    # marker in /tmp is what says "already done" - so a leftover file is not work. Counting it as
    # work (it used to sit above this check) kept the loop from ever sleeping and burned 30% of a
    # core for nothing.
    if [ -e "$SEEN_DIR/$name" ]; then
      continue
    fi
    : > "$SEEN_DIR/$name" 2>/dev/null || true
    handled=1

    now=$(date +%s)
    written=$(stat -c %Y "$request" 2>/dev/null || printf '%s' "$now")
    case "$written" in
      ''|*[!0-9]*) written=$now ;;
    esac
    if [ $((now - written)) -gt "$MAX_AGE_SEC" ]; then
      continue
    fi

    voice="-"
    text=""
    file=""
    music=""
    seconds="0"
    stop=""
    musicstop=""
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        voice=*) voice="${line#voice=}" ;;
        text=*) text="${line#text=}" ;;
        file=*) file="${line#file=}" ;;
        music=*) music="${line#music=}" ;;
        seconds=*) seconds="${line#seconds=}" ;;
        stop=*) stop="${line#stop=}" ;;
        musicStop=*) musicstop="${line#musicStop=}" ;;
      esac
    done < "$request"
    rm -f "$request" 2>/dev/null || true

    case "$seconds" in
      ''|*[!0-9]*) seconds=15 ;;
    esac
    if [ "$seconds" -lt 1 ] 2>/dev/null; then seconds=15; fi

    # A phase event starts without an announcement, so it has to say "no bed here" explicitly.
    if [ -n "$musicstop" ]; then
      stop_music
    fi

    if [ -n "$stop" ]; then
      stop_music
      stop_cue
      continue
    fi

    if [ -n "$music" ]; then
      start_music "$music" "$seconds"
    fi

    if [ -n "$file" ] && [ -f "$file" ]; then
      # A cue is one-shot and short: the bed, if there is one, keeps playing underneath.
      start_cue "$file"
      continue
    fi

    [ -n "$text" ] || continue
    command -v espeak-ng >/dev/null 2>&1 || continue

    wav="/tmp/voice-$$.wav"
    if [ "$voice" = "-" ]; then
      espeak-ng -s 145 -w "$wav" "$text" >/dev/null 2>&1
    else
      espeak-ng -v "$voice" -s 145 -w "$wav" "$text" >/dev/null 2>&1
    fi
    if [ -f "$wav" ]; then
      paplay --device="$SINK" "$wav" >/dev/null 2>&1 || log "could not play the speech"
      log "said [$voice]: $text"
    fi
    rm -f "$wav" 2>/dev/null || true
  done

  [ "$handled" = 1 ] || sleep "$POLL_SEC"
done

