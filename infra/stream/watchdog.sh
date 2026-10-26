#!/bin/bash
# Reconnect watchdog.
#
# The client has no scripting interface, so the cheapest reliable signal is the engine's own
# output: started with -dev it prints connection events ("Disconnected", "Server shutting
# down", "retry #N") to stdout, which stream-entrypoint.sh redirects to /tmp/xash.log. A drop
# therefore shows up as text, and killing the process makes the client loop in the entrypoint
# start it again — a fresh start rejoins through userconfig.cfg.
#
# A frame-brightness check was tried first and thrown away: it cannot separate the main menu
# (mean luma ~60) from a bright map (de_dust2 at 640x480 is ~120).
set -uo pipefail

LOG="${CLIENT_LOG:-/tmp/xash.log}"
CHECK_SEC="${CHECK_SEC:-30}"
STRIKES="${STRIKES:-2}"

# Patterns that mean "the client is no longer playing on the server". "Server connection timed
# out" is what this build prints when the server goes away, and after five failed attempts it
# stops retrying and drops to the menu (retry #5 is the last one). Retries 1-4 are deliberately
# ignored: a server that is still booting makes the client retry a few times on a normal start.
DROP_RE='Server connection timed out|Connection timed out|Disconnected|Server shutting down|Connection to server lost|Server is not responding|retry #5|retry #6'

strikes=0
echo "watchdog: watching $LOG every ${CHECK_SEC}s, ${STRIKES} strikes"

while true; do
  sleep "$CHECK_SEC"
  if ! pgrep -x xash3d > /dev/null; then
    strikes=0
    continue
  fi
  if [ ! -s "$LOG" ]; then
    continue
  fi
  # Only the tail matters: an old disconnect followed by a successful rejoin must not count.
  tail_text=$(tail -n 60 "$LOG" 2>/dev/null | tr -d '\000' | sed 's/\x1b\[[0-9;]*m//g')
  last_join=$(printf '%s\n' "$tail_text" | grep -n 'entered the game\|Server IPv4 address' | tail -1 | cut -d: -f1)
  last_drop=$(printf '%s\n' "$tail_text" | grep -nE "$DROP_RE" | tail -1 | cut -d: -f1)

  if [ -n "$last_drop" ] && { [ -z "$last_join" ] || [ "$last_drop" -gt "$last_join" ]; }; then
    strikes=$((strikes + 1))
    echo "watchdog: disconnect in the log, strike $strikes/$STRIKES"
    if [ "$strikes" -ge "$STRIKES" ]; then
      echo "watchdog: restarting the client to rejoin"
      pkill -x xash3d || true
      strikes=0
    fi
  else
    strikes=0
  fi
done


