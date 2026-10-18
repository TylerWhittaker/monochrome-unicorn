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
# install.ps1 -- fetch the Windows installer and run it, as install.sh
# does elsewhere. In PowerShell:
#
#   irm https://github.com/TylerWhittaker/monochrome-unicorn/releases/latest/download/install.ps1 | iex
#
# which opens the installer's page in your browser. To install from the
# command line instead, pass the address:
#
#   & ([scriptblock]::Create((irm https://.../install.ps1))) 192.168.1.81
#
# The installer is kept in %LOCALAPPDATA%\monochrome-unicorn\ for next
# time. $env:MONOCHROME_UNICORN_URL fetches from somewhere other than the
# latest release.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is far slower drawing it

$base = if ($env:MONOCHROME_UNICORN_URL) { $env:MONOCHROME_UNICORN_URL } else {
  'https://github.com/TylerWhittaker/monochrome-unicorn/releases/latest/download'
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'The installer needs 64-bit Windows.'
}

# x64 runs on ARM64 Windows too, under its emulation.
$name = 'monochrome-unicorn-windows-x64.exe'
$dir = Join-Path $env:LOCALAPPDATA 'monochrome-unicorn'
$exe = Join-Path $dir 'monochrome-unicorn.exe'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Write-Host "Downloading $name ..."
Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile "$exe.part"

$sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content
if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
$expected = ($sums -split "`n" | Where-Object { $_ -match "^([0-9a-f]{64})  $([regex]::Escape($name))\s*$" } |
  ForEach-Object { $Matches[1] }) | Select-Object -First 1
$actual = (Get-FileHash -Algorithm SHA256 "$exe.part").Hash.ToLower()
if (-not $expected -or $actual -ne $expected) {
  Remove-Item -Force "$exe.part"
  throw "The download does not match the release's SHA256SUMS; try again."
}

Move-Item -Force "$exe.part" $exe
& $exe @args
exit $LASTEXITCODE
