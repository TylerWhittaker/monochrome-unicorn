#!/usr/bin/env bash
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
# deploy.sh -- build the console and install it on a Zebra printer.
#
#   ./deploy.sh <printer-ip> [--no-schema] [--no-upload] [--no-clean]
#               [--packed] [--allcv|--allconfig] [--no-telemetry]
#
# The work is done by tools/deploy.mjs, which lists the options
# (./deploy.sh --help); this stays as the name everything has always
# called. Needs node.

set -euo pipefail

cd "$(dirname "$0")"

command -v node >/dev/null || { echo "missing required tool: node" >&2; exit 1; }

exec node tools/deploy.mjs "$@"
