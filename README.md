# Zebra printer console

A single-page console that runs **on** a Zebra printer: the build folds
everything into one `INDEX.SHTML` and uploads it to the printer's flash,
where its onboard web server serves it at `http://<printer>/`.

Three modes:

- **Printer Settings** — every SGD on the printer, `about:config` style:
  filter by name or value, sort them, edit the writable ones with a
  widget chosen from the setting's type and range, see at a glance which
  differ from their factory default. All 574 of them arrive in one
  streamed request, painted as they land.
- **Label Editor** — create and edit stored `.ZPL` labels, either by
  dragging text, barcodes, images, boxes, lines, `^FN` fields and dates
  (`^FC`, filled in from the printer's clock) around a canvas or by
  writing ZPL directly. The preview beside it is the
  printer's own render, not a simulation. Every length is shown in
  inches, millimetres or dots, switched by one radio group and
  remembered between visits.
- **Format Printer** — pick a stored format in any of the printer's
  label languages (ZPL, EPL, CPCL), fill in one box per field, preview
  and print. What is possible varies by language, because the printer's
  web server will only hand back the contents of a `.ZPL`; the mode says
  so rather than pretending otherwise.
- **File System** — every stored object on every drive, with what can
  be done to each: view it (a label as its ZPL, a graphic as a picture,
  a batch file as its escape sequences), download it to your computer,
  edit a `.ZPL` in the Label Editor, print a stored format, run a
  `.BAT`, delete, and upload. Which buttons a row gets is decided by the
  type, because the printer's web server treats types very differently;
  a button that is off says why. The listing is one read of
  `file.drive_listing` — about nine seconds, with the header saying so
  — which is the only place the real extensions live.
- **LCD Viewer** — mirror the printer's front panel on an adjustable
  timer (2 s by default), with a note of how long ago it last refreshed.
  Drawn as a classic green LCD, which brightens when the printer's
  backlight is on. Its keypad presses the printer's own buttons through
  the undocumented `diag.simulate_event`, so the menus can be driven
  from here — and Up and Down change the value on screen, as they do on
  the printer.

## Deploying

```sh
npm install                      # once, for the Tailwind CLI
./deploy.sh 192.168.1.81
```

That reads the printer's setting catalogue, builds `dist/INDEX.SHTML`,
uploads it plus its helper files, and checks what the printer now serves.

The catalogue it captures (`data/sgd-schema.json`) is a property of the
printer in front of you, not of this project, so it is generated rather
than checked in: a fresh clone has none until a deploy -- or
`node tools/fetch-schema.mjs <printer-ip>` -- has fetched one.

```
--no-schema   reuse data/sgd-schema.json instead of re-reading the printer
--no-upload   build only
--clean       remove previously installed helper files first
```

Needs `node`, `nc` (OpenBSD netcat, for `-C`) and `curl`.

Saving and deleting labels from the UI need the printer's 4-digit
password — factory default `1234`. The page asks once per browser
session and keeps it in `sessionStorage`.

## Why it is built this way

The printer sets hard constraints, and most of the design follows from
them. The measurements behind each are in
[docs/printer-notes.md](docs/printer-notes.md).

**No custom CGI, and one page.** Only the built-in endpoints exist, and
the page cannot reference assets it did not bring with it. So the build
inlines the CSS, htmx, the app and the setting catalogue into a single
file.

**~56 KB/s.** That makes page weight the main budget — a 480 KB page
takes 8.3 s to serve. The build prints the breakdown and keeps the total
near 200 KB. Ace (~400 KB) is the one thing loaded from a CDN, on demand,
the first time you open the source view; when the client has no internet
the editor falls back to a textarea with its own ZPL highlighting, so the
console still works on an isolated network.

**Settings can only be read through the SSI preprocessor.** Reading all
574 readable settings in one page takes 14 s, most of it in a single
setting (`file.drive_listing`, which walks ROM). So the build emits one
small `V_<BRANCH>.SHTML` per settings branch, each listing its settings
as `@name=<!--#exec getvar.cgi name-->@`. The client reads a branch in
about 0.1 s, re-reads one after a write, and fills the table in as each
branch lands. The slow settings are left out of the sweep and get a file
of their own, fetched only when you press Read now.

The preprocessor HTML-escapes what it substitutes, so values come back
with `&amp;`, `&quot;` and friends; `parseVarFile` decodes them. Skipping
that would not just look wrong — a write whose value contained any of
those characters would never match on read-back and would be reported as
failed.

**`setvars.cgi` reports nothing.** It answers 200 with an empty body for
a successful write, an out-of-range value and a misspelt setting name
alike. Every write is therefore followed by a read-back of that branch,
and the row reports the value the printer actually kept.

**The LCD framebuffer cannot cross the web server.** `display.image`
returns a real 240x110 BMP of the front panel, but `getvar.cgi`
truncates every value at its first NUL byte and a BMP has one four bytes
in, so the page gets `BM\xfd\x0d` and nothing more. The raw port that
returns it whole is not something a browser can speak to, and the
detours (`file.capture_response`, ZBI) are respectively unimplemented
here and unlicensed. So the LCD Viewer draws `display.text`, the same
screen as a 20x6 character grid, which survives intact; `tools/lcd-shot.mjs`
fetches the actual bitmap from a machine that can reach port 9100.

**The printer is the renderer.** Only it knows how its fonts and
symbologies rasterize, and its `/zpl` endpoint will draw a label to a
bitmap for free. The visual canvas is deliberately an editing proxy —
good enough to position things — while the preview shows the truth.

## Layout

```
src/index.html        page shell, with the {{...}} slots the build fills
src/css/app.css       Tailwind input plus a few component classes
src/js/
  app.js              entry point: header, tab bar, mode mounting
  state.js            printer facts and unit conversion
  printer.js          every call to the printer's web server
  settings.js         mode 1
  editor.js           mode 2
  format.js           mode 3
  lcd.js              mode 4
  zpl.js              label model, ZPL generation and parsing
  formats.js          ZPL / EPL / CPCL: fields and recall syntax
  wysiwyg.js          the drag-and-drop canvas
  inspector.js        label and element property panels
  imageprep.js        image -> one-bit .GRF conversion
  imagedialog.js      pick, preview and upload an image
  codeeditor.js       Ace loader, ZPL syntax mode, offline fallback
  preview.js          the preview pane (htmx round-trip to /zpl)
  ui.js               DOM helpers, toasts, modals, password prompt
tools/
  fetch-schema.mjs    read the SGD catalogue over port 9100
  build.mjs           bundle and inline everything
  upload.mjs          CISDFCRC16 file upload
  lcd-shot.mjs        save the LCD framebuffer as a PNG (needs port 9100)
test/                 round-trip tests for the ZPL model and the
                      helper-file parser
docs/printer-notes.md what the printer does, measured
reference/            the ZPL, CPCL and EPL2 programming manuals
```

## Working on it

```sh
node test/zpl.test.mjs      # ZPL generation/parsing round-trips
node test/printer.test.mjs  # helper-file parsing and entity decoding
node test/state.test.mjs    # which interface's IP the header shows
node tools/build.mjs        # build without touching a printer
npm run format              # lay out every .js/.mjs with prettier
```

All JavaScript is formatted by [prettier](https://prettier.io), with the
settings in `.prettierrc.json` — the sources, the tools and the tests,
and the JS the build embeds in `INDEX.SHTML` too: the build strips the
comments from the bundled app, then runs it and the page shell's inline
`<script>` back through prettier. The embedded copy is indented with tabs
rather than two spaces, which is still prettier's layout but about 20 KB
lighter to serve. The one exception is `vendor/htmx.min.js`, which is
inlined minified as it ships; laying it out would roughly double its 50 KB.
The pre-commit hook refuses a staged `.js` or `.mjs` that prettier would
change.

`tools/build.mjs` contains a deliberately small ES-module bundler rather
than a dependency. It only understands `import { a, b } from './mod.js'`
and `export function|const|class`, and it rejects anything else instead
of emitting something subtly wrong. Because every module ends up sharing
one scope, it also **rejects duplicate top-level names across modules** —
without that check a collision only shows up as a `SyntaxError` in a
browser you may not have devtools on.

For the same reason the page installs an `error` and
`unhandledrejection` handler that renders failures into the DOM: this
console is normally opened on a bench or a phone.

The printer caches aggressively despite `Expires: 0`. During development
load `http://<printer>/INDEX.SHTML?v=2` (a query string on `/` itself is
a 500).

## Known limits

- The visual editor models the subset of ZPL it can draw. Anything else
  is preserved verbatim and re-emitted, but is only editable in the
  source view; you are told which commands those are when you open the
  label and again before switching views.
- The canvas approximates text width and barcode size. The preview is
  authoritative — check it before printing.
- `^IM` places a stored image at its own size; there is no scaling.
- Uploaded images are reduced to one bit per pixel, because that is all
  a thermal printer stores. The dialog shows the result before sending,
  with a dither option that helps photographs and hurts line art.
- The LCD Viewer shows characters, not pixels, for the reason above. It
  polls only while its tab is on screen and the browser tab is visible,
  so it does not compete with the rest of the console for the printer's
  single-request-at-a-time web server.
- `/dir` answers in 0.14 s but reports any type the web server does not
  know as `---`, losing the extension that decides what can be done with
  a file, and it covers one drive per request. The File System mode
  therefore reads `file.drive_listing` instead: one nine-second read
  with the real names, sizes, dates and all three drives, during which
  the printer answers nothing else.
- What the console can put **on** the printer is what its web server
  accepts: a `.ZPL` through the label form, and a picture as a `.GRF`
  (reduced to one bit here in the browser). A `.PNG` cannot be stored
  over HTTP at all — `~DY` reports success and writes nothing — and
  `.BAT`, `.TXT`, `.EPL` and the rest need the `CISDFCRC16` header on
  port 9100, which a page cannot open. `tools/upload.mjs` does that
  from a computer on the network, and the upload dialog says so with
  the command already filled in.
- Reading a file is the same story in reverse: `.ZPL` comes back from
  the label form and `.BAT`, `.SHTML` and graphics can be fetched
  directly, but the web server answers 500 for a `.NRD` or a `.TTF`.
  (`setvar file.type`, which the manual offers for this, writes the
  contents back to the port the command arrived on — never to an HTTP
  request. Retested through `setvars.cgi`, through the preprocessor and
  from inside a `file.run`: nothing arrives.)
- Printers older than the QLn series (firmware below V68, i.e. before
  Link-OS) have no JSON channel, so their catalogue comes from
  `! U1 getvar "allcv"` instead. `~HI` decides which to use;
  `--allcv`/`--allconfig` force it. allcv lists no factory defaults and
  no access flags, so nothing is marked as changed from default and a
  setting with no list of choices is tagged `read/write?` -- editable,
  and confirmed by the read-back. The Settings tab says so at the top.
- The setting catalogue is captured at build time. Deploying a build to
  a different printer model may show settings it does not have; re-run
  `./deploy.sh <ip>` against that printer to recapture.

## Versioning

[Semantic Versioning](https://semver.org). The version lives in exactly
one place, `package.json`'s `version` field; everything else asks for
it, so there is nothing to keep in step:

```sh
node tools/version.mjs              # what version is this?
node tools/version.mjs bump minor   # a feature; major breaks something
```

The build stamps that version and the time into the page footer, which
is how you tell what a printer is actually running.

Every commit moves the version on: `tools/githooks/pre-commit` bumps the
patch level unless the commit already changes the version itself, so a
feature or a breaking change is a `bump minor`/`bump major` before
committing and the hook then leaves it alone. `npm install` points git
at the hook; by hand it is:

```sh
git config core.hooksPath tools/githooks
```

## Licence

Copyright (C) 2026 Tyler Whittaker.

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU Affero General Public License as published by the
Free Software Foundation, either version 3 of the License, or (at your
option) any later version. It is distributed in the hope that it will be
useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE)
for the full text, or <https://www.gnu.org/licenses/agpl-3.0.html>.

The built `INDEX.SHTML` is a copy of this program, so a printer you hand
to someone else carries it: the page states the licence in its footer and
in an HTML comment at the top. If you give out a printer or a build, you
also owe the recipient the corresponding source — this repository, at the
commit the build came from.

Third-party code, all AGPL-compatible and under its own terms:

- [htmx](https://htmx.org) 2.0.4 (`vendor/htmx.min.js`), inlined into the
  build — Zero-Clause BSD.
- [Tailwind CSS](https://tailwindcss.com) (build-time only; the generated
  CSS is inlined) — MIT.
- [Ace](https://ace.c9.io), fetched from cdnjs at runtime when the source
  editor opens, never redistributed here — BSD 3-Clause.

The Zebra manuals under `reference/` are Zebra Technologies' documents,
included for reference only and not covered by this licence; they are
kept out of the repository by `.gitignore`.
