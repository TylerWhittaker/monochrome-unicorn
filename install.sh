#!/bin/sh
# Monochrome Unicorn -- a web app for Zebra thermal printers.
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
# install.sh -- fetch the installer for this computer and run it.
#
#   curl -fsSL https://github.com/TylerWhittaker/monochrome-unicorn/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- 192.168.1.81 [--packed ...]
#
# With no address the installer opens its page in your browser; with one
# it installs from the command line. Linux (x64, arm64, and WSL) and macOS
# (Apple silicon and Intel). Nothing else is installed: the installer is
# one file that carries what it needs, kept in
# ~/.local/share/monochrome-unicorn/ for next time. Needs curl, and
# sha256sum or shasum to check the download.
#
# MONOCHROME_UNICORN_URL fetches from somewhere other than the latest
# release, e.g. .../releases/download/v0.49.0.

set -eu

BASE=${MONOCHROME_UNICORN_URL:-https://github.com/TylerWhittaker/monochrome-unicorn/releases/latest/download}

fail() {
  echo "install.sh: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  MINGW* | MSYS* | CYGWIN*)
    fail "on Windows, download monochrome-unicorn-windows-x64.exe from $BASE/ instead" ;;
  *) fail "no installer for $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no installer for $(uname -m)" ;;
esac
# A shell under Rosetta says x86_64 on Apple silicon; take the native one.
if [ "$os-$arch" = macos-x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  arch=arm64
fi

name=monochrome-unicorn-$os-$arch
dir=${XDG_DATA_HOME:-$HOME/.local/share}/monochrome-unicorn
bin=$dir/monochrome-unicorn
mkdir -p "$dir"

echo "Downloading $name ..." >&2
curl -fL --progress-bar -o "$bin.part" "$BASE/$name" || fail "could not download $BASE/$name"

if command -v sha256sum >/dev/null; then
  sum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null; then
  sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sum() { echo unchecked; }
fi
expected=$(curl -fsSL "$BASE/SHA256SUMS" | awk -v n="$name" '$2 == n { print $1 }')
actual=$(sum "$bin.part")
if [ "$actual" = unchecked ]; then
  echo "(no sha256sum or shasum here, so the download is not checked)" >&2
elif [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
  rm -f "$bin.part"
  fail "the download does not match the release's SHA256SUMS; try again"
fi

chmod +x "$bin.part"
mv -f "$bin.part" "$bin"
exec "$bin" "$@"
