#!/usr/bin/env bash
# Zebra Printer Console -- a web console served from a Zebra printer.
# Copyright (C) 2026 Tyler Whittaker
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later

#
# deploy.sh -- build the console and install it on a Zebra printer.
#
#   ./deploy.sh <printer-ip> [options]
#
#     --no-schema   reuse data/sgd-schema.json instead of re-reading the
#                   printer's SGD catalogue (faster; use when you know the
#                   target printer matches the captured one)
#     --allcv       read the catalogue with `! U1 getvar "allcv"` rather
#                   than the JSON allconfig. Pre-Link-OS printers (firmware
#                   below V68) have no JSON channel and are detected by ~HI,
#                   so this is only needed to force it on a printer that
#                   would otherwise be asked for JSON
#     --allconfig   force the JSON catalogue, skipping the ~HI check
#     --no-upload   build only, leave the printer alone
#     --clean       remove the helper files this tool installed (V_* and
#                   S_*) before uploading the new set
#
# The printer is reached two ways: port 9100 for raw file writes (nc -C,
# CISDFCRC16 header) and port 80 to verify what it now serves.

set -euo pipefail

cd "$(dirname "$0")"

IP=""
FETCH_SCHEMA=1
UPLOAD=1
CLEAN=0
SCHEMA_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --no-schema) FETCH_SCHEMA=0 ;;
    --no-upload) UPLOAD=0 ;;
    --clean)     CLEAN=1 ;;
    -h|--help)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --allcv)     SCHEMA_ARGS+=(--allcv) ;;
    --allconfig) SCHEMA_ARGS+=(--allconfig) ;;
    -*)          echo "unknown option: $1" >&2; exit 2 ;;
    *)           IP="$1" ;;
  esac
  shift
done

if [ -z "$IP" ] && { [ "$UPLOAD" = 1 ] || [ "$FETCH_SCHEMA" = 1 ]; }; then
  echo "usage: ./deploy.sh <printer-ip> [--no-schema] [--no-upload] [--clean] [--allcv|--allconfig]" >&2
  exit 2
fi

for tool in node nc curl; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

if [ "$FETCH_SCHEMA" = 1 ]; then
  node tools/fetch-schema.mjs "$IP" ${SCHEMA_ARGS[@]+"${SCHEMA_ARGS[@]}"}
else
  echo "Using cached data/sgd-schema.json"
fi

node tools/build.mjs

if [ "$UPLOAD" = 0 ]; then
  echo "Skipping upload."
  exit 0
fi

if [ "$CLEAN" = 1 ]; then
  echo "Removing previously installed helper files..."
  # ^ID takes one object per format block; send them in a single connection.
  curl -s --max-time 20 "http://$IP/dir?dev=E" \
    | grep -oE 'E:(V|S)_[A-Z0-9_]+\.' \
    | sort -u \
    | sed 's/\.$//' \
    | while read -r obj; do printf '^XA^ID%s.SHTML^FS^XZ\r\n' "$obj"; done \
    | nc -C -q 3 "$IP" 9100 || true
fi

echo "Uploading to $IP ..."
UPLOAD_ARGS=(dist/INDEX.SHTML "E:INDEX.SHTML")
for f in dist/helpers/*.SHTML; do
  UPLOAD_ARGS+=("$f" "E:$(basename "$f")")
done
node tools/upload.mjs "$IP" "${UPLOAD_ARGS[@]}"

echo "Verifying..."
sleep 1
SERVED=$(curl -s --max-time 60 -o /dev/null -w '%{http_code} %{size_download}' "http://$IP/INDEX.SHTML")
echo "  http://$IP/INDEX.SHTML -> $SERVED"
ROOT=$(curl -s --max-time 60 -o /dev/null -w '%{http_code} %{size_download}' "http://$IP/")
echo "  http://$IP/            -> $ROOT"
echo
echo "Open http://$IP/"
