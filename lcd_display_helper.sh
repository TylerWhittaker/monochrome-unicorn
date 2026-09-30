#!/usr/bin/env bash
#
# Zebra Printer Console -- a web console served from a Zebra printer.
# Copyright (C) 2026 Tyler Whittaker
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# lcd_display_helper.sh -- let the LCD Viewer show the printer's real screen.
#
# The front panel is a 240x110 bitmap in the display.image setting, but
# the printer's web server cannot pass it on (getvar.cgi stops at the
# first NUL byte, four bytes into the BMP), and a web page cannot open
# port 9100, where it comes back whole. This script can. Every second it
#
#   1. reads display.image over port 9100 and saves it as lcd.bmp here;
#   2. stores the same picture on the printer, in RAM, as R:LCD.GRF,
#      where the LCD Viewer finds it through the printer's own /png.
#
# The page cannot be pointed at lcd.bmp instead: a page cannot read files
# on your computer, and Chrome will not let a page served over plain
# http from the LAN fetch from another machine or from localhost either.
# The printer is the one place both can reach.
#
# R: is the printer's RAM drive, so this costs no flash wear, and the
# picture goes when the printer restarts. Ctrl-C removes it at once.
#
# The stored graphic has one row more than the screen: a stamp carrying
# a frame counter and the backlight state, so the page can tell a live
# helper from a picture left behind.
#
# usage: ./lcd_display_helper.sh <printer-ip> [--interval 1] [--out lcd.bmp]
#
# Needs bash, nc (OpenBSD netcat), od, awk and GNU head.

set -u

INTERVAL=1
OUT=lcd.bmp
IP=

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) INTERVAL=$2; shift ;;
    --out) OUT=$2; shift ;;
    -h|--help) sed -n '7,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) IP=$1 ;;
  esac
  shift
done

if [ -z "$IP" ]; then
  echo "usage: $0 <printer-ip> [--interval 1] [--out lcd.bmp]" >&2
  exit 2
fi

for tool in nc od awk; do
  command -v "$tool" >/dev/null || { echo "$0: needs $tool" >&2; exit 1; }
done

TMP=$OUT.part

# Send ZPL (or a getvar) to the raw port and print whatever comes back.
send() {
  printf '%s\r\n' "$1" | nc -q 0 -w 5 "$IP" 9100
}

# One getvar; the reply is the value wrapped in double quotes.
getvar() {
  printf '! U1 getvar "%s"\r\n' "$1" | nc -q 0 -w 5 -C "$IP" 9100
}

# Turn a 1-bit BMP into a ~DG command for R:LCD.GRF: rows top-down, a set
# bit for a dark pixel, then the stamp row -- "LCD", version 1, the frame
# counter (32 bits, big-endian) and the backlight (1 on, 0 off).
bmp_to_dg() {
  od -An -v -tu1 "$1" | awk -v seq="$2" -v lit="$3" '
    { for (i = 1; i <= NF; i++) b[n++] = $i }
    function u16(o) { return b[o] + 256 * b[o + 1] }
    function u32(o) { return u16(o) + 65536 * u16(o + 2) }
    function s32(o,  v) { v = u32(o); return v >= 2147483648 ? v - 4294967296 : v }
    END {
      if (n < 62 || b[0] != 66 || b[1] != 77 || u16(28) != 1) exit 1
      off = u32(10); w = s32(18); h = s32(22)
      rows = h < 0 ? -h : h
      stride = int((w + 31) / 32) * 4
      bpr = int((w + 7) / 8)
      # Which palette entry is dark decides whether the bits need flipping.
      flip = (b[54] + b[55] + b[56]) < (b[58] + b[59] + b[60])
      printf "~DGR:LCD.GRF,%d,%d,", bpr * (rows + 1), bpr
      for (y = 0; y < rows; y++) {
        src = h < 0 ? y : rows - 1 - y
        for (x = 0; x < bpr; x++) {
          v = b[off + src * stride + x]
          printf "%02X", flip ? 255 - v : v
        }
      }
      stamp[0] = 76; stamp[1] = 67; stamp[2] = 68; stamp[3] = 1
      for (k = 0; k < 4; k++) stamp[4 + k] = int(seq / 256 ^ (3 - k)) % 256
      stamp[8] = lit
      for (x = 0; x < bpr; x++) printf "%02X", (x in stamp) ? stamp[x] : 0
      printf "\n"
    }'
}

cleanup() {
  rm -f "$TMP"
  # Take the picture off the printer, so the page falls back at once.
  send '^XA^IDR:LCD.GRF^FS^XZ' >/dev/null 2>&1
}
trap cleanup EXIT
trap 'exit 0' INT TERM

echo "Watching the front panel of $IP every ${INTERVAL}s."
echo "Saving $OUT here, and storing R:LCD.GRF on the printer for the LCD Viewer."
echo "Open the LCD Viewer: it switches to the real screen on its own. Ctrl-C to stop."

seq=0
last_error=
while :; do
  # The quotes are the first and last byte; everything between is the BMP.
  getvar display.image | tail -c +2 | head -c -1 >"$TMP"

  error=
  if [ "$(head -c 2 "$TMP" 2>/dev/null)" != BM ] || [ "$(wc -c <"$TMP")" -le 62 ]; then
    error="no bitmap from $IP:9100 (is it on, and is this the right address?)"
  else
    mv -f "$TMP" "$OUT"
    seq=$(((seq + 1) % 4294967296))
    lit=1
    [ "$(getvar display.backlight | tr -d '"\r\n')" = off ] && lit=0
    if dg=$(bmp_to_dg "$OUT" "$seq" "$lit"); then
      send "$dg" >/dev/null || error="could not store R:LCD.GRF on $IP"
    else
      error="the printer sent a bitmap this script does not understand"
    fi
  fi

  if [ "$error" != "$last_error" ]; then
    if [ -n "$error" ]; then echo "$(date +%T) $error" >&2; else echo "$(date +%T) reading again"; fi
    last_error=$error
  fi

  sleep "$INTERVAL"
done
