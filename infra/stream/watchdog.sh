#!/bin/bash
# Watchdog for the capture container: keeps the client in the game and reports liveness.
#
# Two different failures both look like "the stream froze", so both are handled here:
#   1. the client is no longer on the server (kick, timeout, a map change gone wrong) and sits in
#      its own menu. The engine's log stops growing and its last lines say why - kill the client,
#      the entrypoint starts it again and it rejoins from userconfig.cfg;
#   2. the client is on the server but the picture does not change (the "choose a team" panel or a
#      dead observer target drawn over the game). The log keeps growing, so only the frames can
#      tell: a two-second freezedetect sample decides.
#
# The same loop writes runtime.json into the shared volume. The admin panel shows its age and the
# `frozen` flag, which is the difference between "the encoder died" and "the scene is static".
#
# A frame-brightness check was tried first and thrown away: it cannot separate the main menu
# (mean luma ~60) from a bright map (de_dust2 at 640x480 is ~120). freezedetect looks at frame
# difference instead of absolute brightness, so it works on a bright map and in a dark menu alike.
set -uo pipefail

LOG="${CLIENT_LOG:-/tmp/xash.log}"
STATUS_DIR="${STATUS_DIR:-/game/.stream}"
CHECK_SEC="${CHECK_SEC:-15}"
STRIKES="${STRIKES:-2}"
MOTION_SEC="${MOTION_SEC:-20}"
# A client that is on the server keeps producing log lines (bots chat and die constantly). Silence
# for two minutes therefore means "not on the server", which catches the menu case even when the
# disconnect line was not printed at all.
LOG_STALE_SEC="${LOG_STALE_SEC:-120}"
# A frozen picture only restarts the client after this many samples in a row (~1 min): the stretch
# between rounds is legitimately static and must not cost a rejoin.
FROZEN_STRIKES="${FROZEN_STRIKES:-4}"
DISPLAY_NAME="${DISPLAY:-:99}"
CAP_W="${CAP_W:-960}"
CAP_H="${CAP_H:-720}"

# Case-insensitive matching, because the engine's wording differs between builds: the kick that
# froze the first live stream read "Server issued disconnect. Reason: Kicked" and matched nothing.
DROP_RE='server issued disconnect|has been idle for too long|kicked by console|connection to server lost|server connection timed out|connection timed out|disconnected|server shutting down|retry #5|retry #6'

strikes=0
fstrikes=0
restarts=0
frozen="unknown"
motion_at=0
log_changed_at=$(date +%s)
log_size=0

# moving | frozen | unknown
check_motion() {
  local out
  out=$(timeout 14 ffmpeg -hide_banner -loglevel info -nostdin \
      -f x11grab -video_size "${CAP_W}x${CAP_H}" -framerate 5 -i "${DISPLAY_NAME}.0" \
      -t 3 -vf "freezedetect=n=-60dB:d=2.0" -f null - 2>&1) || { echo unknown; return; }
  case "$out" in
    *freeze_start*) echo frozen ;;
    *"frame="*)     echo moving ;;
    *)              echo unknown ;;
  esac
}

write_runtime() {
  local alive="$1" log_age="$2" motion="$3" tmp
  mkdir -p "$STATUS_DIR" 2>/dev/null || return 0
  tmp="$STATUS_DIR/.runtime.tmp"
  printf '{"ts":%s,"xashAlive":%s,"logAgeSec":%s,"frozen":%s,"restarts":%s}\n' \
    "$(date +%s)" \
    "$([ "$alive" = 1 ] && echo true || echo false)" \
    "${log_age:-null}" \
    "$(case "$motion" in frozen) echo true ;; moving) echo false ;; *) echo null ;; esac)" \
    "$restarts" > "$tmp" 2>/dev/null && mv -f "$tmp" "$STATUS_DIR/runtime.json" 2>/dev/null
  return 0
}

echo "watchdog: watching $LOG every ${CHECK_SEC}s, ${STRIKES} strikes, motion every ${MOTION_SEC}s -> $STATUS_DIR/runtime.json"


while true; do
  sleep "$CHECK_SEC"
  now=$(date +%s)
  alive=0
  pgrep -x xash3d > /dev/null && alive=1
  reason=""

  # Log growth is the cheapest liveness signal and the only one that survives a client sitting in
  # a menu: no new lines means it is not watching a match. Size, not content: the entrypoint
  # truncates the file on every client restart, so a shrink must count as a change too.
  if [ -s "$LOG" ]; then
    size=$(wc -c < "$LOG" 2>/dev/null || echo 0)
    if [ "$size" -ne "$log_size" ]; then
      log_size=$size
      log_changed_at=$now
    fi
  fi
  log_age=$(( now - log_changed_at ))

  if [ "$alive" = 1 ]; then
    # Only the tail matters: an old disconnect followed by a successful rejoin must not count.
    tail_text=$(tail -n 40 "$LOG" 2>/dev/null | tr -d '\000' | sed 's/\x1b\[[0-9;]*m//g')
    last_join=$(printf '%s\n' "$tail_text" | grep -n 'entered the game\|joined team\|Server IPv4 address' | tail -1 | cut -d: -f1)
    last_drop=$(printf '%s\n' "$tail_text" | grep -niE "$DROP_RE" | tail -1 | cut -d: -f1)
    if [ -n "$last_drop" ] && { [ -z "$last_join" ] || [ "$last_drop" -gt "$last_join" ]; }; then
      reason="the client left the server"
    elif [ "$log_age" -ge "$LOG_STALE_SEC" ]; then
      reason="no client log line for ${log_age}s"
    fi

    # The picture check runs on its own clock: a 3 s grab costs more than a log stat.
    if [ $(( now - motion_at )) -ge "$MOTION_SEC" ]; then
      motion_at=$now
      frozen=$(check_motion)
      if [ "$frozen" = frozen ]; then
        fstrikes=$((fstrikes + 1))
        echo "watchdog: picture is static ($( [ "$fstrikes" -ge "$FROZEN_STRIKES" ] && echo restarting || echo "sample $fstrikes/$FROZEN_STRIKES" ))"
      elif [ "$frozen" = moving ]; then
        fstrikes=0
      fi
    fi
  else
    strikes=0
    fstrikes=0
  fi

  if [ -n "$reason" ]; then
    strikes=$((strikes + 1))
    echo "watchdog: $reason, strike $strikes/$STRIKES"
  elif [ "$alive" = 1 ]; then
    strikes=0
  fi

  # A dead observer target is frozen for as long as the round lasts, so the picture test needs a
  # higher bar than the log test: a static stretch between rounds must not restart a healthy client.
  if [ "$alive" = 1 ] && { [ "$strikes" -ge "$STRIKES" ] || [ "$fstrikes" -ge "$FROZEN_STRIKES" ]; }; then
    echo "watchdog: restarting the client (strikes $strikes, static samples $fstrikes)"
    pkill -x xash3d || true
    restarts=$((restarts + 1))
    strikes=0
    fstrikes=0
    log_size=0
    log_changed_at=$now
    frozen="unknown"
  fi

  write_runtime "$alive" "$log_age" "$frozen"
done



