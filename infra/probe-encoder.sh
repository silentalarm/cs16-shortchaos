#!/bin/sh
# Diagnostic: runs the encoder once with a modified flag set and reports whether frames flow.
# Usage (inside the capture container, where Xvfb, the engine and PulseAudio already run):
#   sh /tmp/probe-encoder.sh <variant> <rtmp-path>
# Variants exist because the first packet can be held back by input probing, and this is how the
# working combination was found.
set -u

variant="${1:-default}"
path="${2:-live/probe}"

common_video="-f x11grab -draw_mouse 0 -framerate 30 -video_size 960x720 -i :99.0"
common_rest="-thread_queue_size 512 -f pulse -i cs.monitor -af aresample=async=1:first_pts=0,volume=-8dB,alimiter=limit=0.95:level=false -vf scale=720:540:flags=bicubic,pad=720:1280:0:140:color=0x101014,format=yuv420p -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -b:v 2000k -maxrate 2000k -bufsize 4000k -g 60 -keyint_min 30 -sc_threshold 0 -c:a aac -b:a 128k -shortest -f flv"

case "$variant" in
  noprobe)   video="-thread_queue_size 512 $common_video" ; rest="$common_rest" ;;
  sendonly)  video="-thread_queue_size 512 -analyzeduration 0 -probesize 32 $common_video" ; rest="-thread_queue_size 512 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 -c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 2000k -g 60 -c:a aac -b:a 128k -shortest -f flv" ;;
  videoonly) video="-thread_queue_size 512 $common_video" ; rest="-c:v libx264 -preset veryfast -pix_fmt yuv420p -b:v 2000k -g 60 -an -f flv" ;;
  *)         video="-thread_queue_size 512 -analyzeduration 0 -probesize 32 $common_video" ; rest="$common_rest" ;;
esac

rm -f /tmp/probe.log
timeout 14 ffmpeg -hide_banner -loglevel info -nostdin -y $video $rest "rtmp://mediamtx:1935/$path" > /tmp/probe.log 2>&1
code=$?

echo "variant=$variant exit=$code"
grep -c 'frame=' /tmp/probe.log || true
grep -E 'frame=' /tmp/probe.log | tail -1 || true
grep -E 'Broken pipe|Conversion failed|not enough frames' /tmp/probe.log | tail -2 || true
