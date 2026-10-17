# Monochrome Unicorn

*A web app for Zebra thermal printers.*

A single-page console that runs **on** a Zebra printer: the build folds
everything into one `INDEX.SHTML` and uploads it to the printer's flash,
where its onboard web server serves it at `http://<printer>/`.

The header shows the printer's status -- ready, paused, paper out,
ribbon out or head open -- refreshed every 15 seconds, and a Printer
menu for what is otherwise done at the printer: feed a label, pause and
resume, cancel all jobs, calibrate, print the configuration label.

Four modes:

- **Printer Settings** — every SGD on the printer, Firefox `about:config` 
  style: filter by name or value, sort them, edit the writable ones with 
  a widget chosen from the setting's type and range, see at a glance 
  which differ from their factory default. All ~574 of them arrive in one
  streamed request, painted as they land. Click a setting's name for
  what it is for -- a summary written for every setting of the printers
  this was built against (`src/data/sgd-reference.mjs`, served as
  `SGDREF.SHTML` and read on first use) -- with its range and default.
  Below the table, a Maintenance card shows the odometers -- media run
  since the head was cleaned and since it was replaced, labels, cuts,
  head temperature, uptime -- with buttons to reset the head counters.
  Under it, a Media sensor card shows which sensor finds the labels
  (gap or black mark), each sensor's reading against its label and
  paper-out thresholds, and Watch re-reads them every second for two
  minutes, so moving the media by hand shows the reading change; with
  Calibrate (`~JC`) and Print sensor profile (`~JG`) beside it. The
  profile graph itself only exists on paper: the printer prints it and
  hands nothing back.
  **Back up…** downloads the settings that differ from their default
  (or every writable one) as JSON; **Restore…** reads one back, shows
  it against this printer with the differing ones ticked, and writes
  the ticked ones, each confirmed by read-back. Passwords and keys
  never go in a backup, nor do the clock, the odometers, commands or
  user variables; the network address and identity only when asked.
  **Syslog & alerts**, beside All settings, is a tool of its own: the
  printer's syslog (`device.syslog.entries`, or `E:SYSLOG.TXT`) a line
  at a time, its feature, severity and code picked out and coloured,
  filtered by severity, feature and words, downloaded or cleared; the
  syslog settings, the destination list edited as rows of severity and
  "kept on the printer" or a server's address; and the alerts
  (`alerts.configured`) the same way, each condition, destination,
  on-set and on-clear, address, port and quelling, with the e-mail and
  SNMP settings they are sent with and the alert system's own logs.
  Each list is checked as it is edited, and shown as the string that
  will be written; every write is read back.
- **Label Editor** — create and edit stored `.ZPL` labels, either by
  dragging text, barcodes (twenty symbologies, GS1 and postal among
  them), serial numbers (`^SN`, counting from label to label), images,
  boxes, ellipses, straight and diagonal lines, `^FN` fields and dates
  (`^FC`, filled in from the printer's clock) around a canvas or by
  writing ZPL directly. Text can run vertically or reversed, in the
  built-in fonts or any TrueType font stored on the printer (`^A@`).
  In the source view, the panel beside it explains the command under
  the cursor -- what it does, and each parameter with the value the
  label gives it -- from a reference written for every command in the
  ZPL guide (`src/data/zpl-reference.mjs`), served as `ZPLREF.SHTML` and
  read the first time it is wanted. The preview beside it is the
  printer's own render, not a simulation; its Zoom fits it to the pane
  or shows it at a fixed size, 100% being one screen pixel to a printer
  dot, scrolling when it is bigger than the pane (remembered). Every length is shown in
  inches, millimetres or dots, switched by one radio group and
  remembered between visits.
  Several elements can be selected at once -- Shift-click, Ctrl+A, or
  a drag across the empty label -- then moved, nudged, deleted, lined
  up or spaced evenly together. Ctrl+C puts them on the clipboard as
  ZPL and Ctrl+V pastes copies; ZPL copied from anywhere else pastes
  as the elements it draws.
  A drag snaps to smart guides -- the edges and centres of the other
  elements and of the label, drawn as blue lines while they hold --
  unless the grid is on, when it lands on the grid instead; Alt drags
  freely. A Layers card under the canvas, collapsed until its arrow
  opens it, lists the elements top-most first: click one to select it (even one buried under others), drag
  rows or use To front / Forward / Backward / To back to change the
  order the ZPL draws them in, and Hide (off the canvas, still printed)
  or Lock (not dragged or nudged) any of them -- those two are the
  editor's own and not saved with the label. On a touch screen two
  fingers pinch the zoom, a long press adds an element to the
  selection, a finger on empty space scrolls rather than drawing a band,
  and the resize handle and buttons are bigger. Press `?` anywhere, or
  the editor's `?` button, for every keyboard shortcut.
- **Stored Formats** — pick a stored format in any of the printer's
  label languages (ZPL, EPL, CPCL), fill in one box per field, preview
  and print. The fields are read from the format itself, in any of the
  three; only a ZPL format can be previewed, because the printer only
  renders ZPL, and the mode says so rather than pretending otherwise. CPCL formats only show up in the
  drive listing (below), so they join the list when it lands, with a
  note beside the list while it is being read. A batch from CSV prints
  one label per row, the columns matched to fields by name; Previous,
  Next and the arrow keys step the preview through the rows, and a note
  says which rows leave a field empty, or which field has no column. A field the
  format itself fills in (`^FN3^FD12345`) is shown but fixed: printers
  ignore data sent for it.
- **File System** — every stored object on every drive, with what can
  be done to each: view it (a label as its ZPL, a graphic as a picture,
  a batch file as its escape sequences), download it to your computer,
  edit a `.ZPL` in the Label Editor and any other text file in place
  (a `.WML` menu, an EPL or CPCL format, a `.BAT`...), print a stored
  format, run a `.BAT`, delete, upload a file of any type, or write a
  new one (**New file…**). Files other than `.ZPL` and pictures are
  written through the undocumented `file.append` setting: in chunks,
  read back and compared, and only then put in place of the old one;
  one with a NUL byte (a font, say) cannot go that way, and is turned
  away with the `tools/upload.mjs` command to use instead. Which buttons a row gets is decided by the
  type, because the printer's web server treats types very differently;
  a button that is off says why. **Pictures** shows every graphic as a
  thumbnail instead, with Rename (`^TO` copies it, and only once the
  copy is listed does `^ID` remove the original); the Label Editor's
  Choose… picks an image from the same thumbnails. The listing is one read of
  `file.drive_listing` — about nine seconds, with the header saying so
  — which is the only place the real extensions live. Settings reads it
  once its own sweep is done and keeps one copy for the whole console,
  so this mode and Stored Formats open on that copy and re-read it in
  the background (unless it is under a minute old; Refresh always
  re-reads).
- **LCD Viewer** — mirror the printer's front panel on an adjustable
  timer (1 s by default), with a note of how long ago it last refreshed.
  Drawn as a classic green LCD, which brightens when the printer's
  backlight is on. Its keypad presses the printer's own buttons through
  the undocumented `diag.simulate_event`, so the menus can be driven
  from here — and Up and Down change the value on screen, as they do on
  the printer. It draws the screen from `display.text`, laid out in
  the columns and size of the font the menu on screen asks for (a WML
  `<font>` tag, read from the file `display.load_card` names) — unless
  `./lcd_display_helper.sh <printer-ip>` is running on a computer that
  can reach the printer, and then it draws the printer's own pixels
  (below). The mode tells you how to start it. A printer whose
  catalogue has no `display.*` branch has no display, so its build
  leaves this mode out: no tab, and no `LCD.SHTML` uploaded.

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
--no-clean    keep previously installed helper files (by default
              they are removed before the new set is uploaded)
--packed      gzip the page, about 170 KB instead of 440; below
```

The page is plain by default: the styles, htmx, the app and the
catalogue inlined as they are, about 440 KB. Measured, the printers
serve it in about a second over Wi-Fi (docs/printer-notes.md), and it
runs in Chrome 86, Safari 14 or Firefox 78 and later. For a printer
whose clients are on a slow link, pack it instead:

```sh
make build-packed                    # dist/INDEX.SHTML, packed
make deploy-packed IP=192.168.1.81   # or ./deploy.sh <ip> --packed
```

Packed, it is the same console at about 170 KB -- gzipped together,
carried as base64, and unpacked in the browser with `DecompressionStream`
-- and its footer says "packed". That needs Safari 16.4 or Firefox 113
or later (Chrome 86 either way); an older browser is told so on the
page. Older than the plain page's versions, the app's own JavaScript
(`??`, `?.`, `replaceChildren`) is too new and would need transpiling,
which this build does not do. One thing degrades rather than fails:
before Chrome 87 and Firefox 116, the canvas's text outlines are not
fitted to the drawn text (`fontBoundingBoxAscent`). A deploy without
`--packed` -- `make deploy`, or the post-commit hook -- puts the plain
page back, so deploy the packed one again after it.

Needs `node` (with npm) and `curl`. Port 9100 is reached through Node's
own sockets, so there is no netcat to install.

Saving and deleting labels from the UI need the printer's 4-digit
password. The page tries the factory default, `1234`, first and only
asks if the printer rejects it; a password that works is kept in
`sessionStorage` for the rest of the browser session.

## Why it is built this way

The printer sets hard constraints, and most of the design follows from
them. The measurements behind each are in
[docs/printer-notes.md](docs/printer-notes.md).

**No custom CGI, and one page.** Only the built-in endpoints exist, and
the page cannot reference assets it did not bring with it. So the build
inlines the CSS, htmx, the app and the setting catalogue into a single
file, about 440 KB. `--packed` gzips those four together into base64
that a short script in the page (`src/unpack.js`) unpacks with the
browser's own `DecompressionStream`, about 170 KB, for a slow link or an
old printer; see Deploying, above. What the printer's preprocessor fills
in (`boot-vars`) and the footer stay plain text either way.

**A few hundred KB/s.** Measured, the printers serve 260-390 KB/s over
Wi-Fi and 370-560 KB/s wired (docs/printer-notes.md), so the plain page
loads in about a second and the packed one in about half that; a phone
on a weak link will be slower. Page weight is still watched: the build
prints the breakdown, and the live tests fail a plain page over 600 KB
or a packed one over 250 KB. Ace (~400 KB) is the one thing loaded from
a CDN, on demand, the first time you open the source view; when the client has no internet
the editor falls back to a textarea with its own ZPL highlighting, so the
console still works on an isolated network.

**Settings can only be read through the SSI preprocessor.** Reading all
574 readable settings in one page takes 14 s, most of it in a single
setting (`file.drive_listing`, which walks ROM). So the build emits
helper files listing settings as `@name=<!--#exec getvar.cgi name-->@`:
`V_ALL.SHTML` with every one, which the client streams and paints as the
values land, and a dozen `V_<n>.SHTML` holding whole branches -- the big
ones alone, the small ones packed up to 40 settings a file -- one of which
is re-read after each write (0.1-0.4 s). The slow settings are left out
of the sweep and get a file of their own, fetched only when you press
Read now. Every deploy removes the previous set before uploading, so a
catalogue that packs differently leaves nothing stale on `E:`.

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
screen as a 20x6 character grid, which survives intact.

For the real pixels, `lcd_display_helper.sh` runs on a computer that can
reach port 9100. Each second it reads the bitmap, saves it as `lcd.bmp`,
and stores it on the printer's RAM drive as `R:LCD.GRF` (plain-ASCII
`~DG`, so no flash wear and nothing binary on the wire). The page reads
that back through `/png`, 60 ms, and draws it. The helper cannot simply
serve `lcd.bmp` to the page: a page cannot read local files, and Chrome
will not let an `http://` page on the LAN fetch from `localhost` or
another machine (Local Network Access). The printer is the one place both
can reach. An extra row under the picture carries a frame counter and
the backlight, so the page can tell a live helper from a frame left
behind; Ctrl-C removes the frame, and a printer restart would too.
The helper talks to the printer through bash's own `/dev/tcp`, so it
needs only bash, `dd`, `od` and `awk`. `tools/lcd-shot.mjs` takes a
single screenshot the same way, through a Node socket.

**The printer is the renderer.** Only it knows how its fonts and
symbologies rasterize, and its `/zpl` endpoint will draw a label to a
bitmap for free. The visual canvas is deliberately an editing proxy —
good enough to position things — while the preview shows the truth.

## Layout

```
src/index.html        page shell, with the {{...}} slots the build fills
src/unpack.js         the packed page's first script (--packed): unpacks the rest
src/css/app.css       Tailwind input plus a few component classes
src/js/
  app.js              entry point: header, tab bar, mode mounting
  state.js            printer facts and unit conversion
  printer.js          every call to the printer's web server
  drives.js           the shared copy of file.drive_listing
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
  store.js            a mode's state, and the views told when it changes
  zplhelp.js          the source view's panel: the command under the cursor
  shortcuts.js        the ? sheet: every keyboard shortcut, in one list
  gallery.js          stored pictures as thumbnails; rename
  filewrite.js        storing any file through file.append: chunks, encoding
  layers.js           the Label Editor's Layers card: order, hide, lock
  maintenance.js      the Maintenance card: odometers
  sensor.js           the Media sensor card: readings and thresholds
  logs.js             Syslog & alerts: the log viewer and both editors
  syslog.js           syslog lines and the syslog / alert strings, as data
src/data/
  zpl-reference.mjs   every ZPL command and parameter, in our words
  sgd-reference.mjs   what each printer setting is for, likewise
lcd_display_helper.sh copy the real LCD bitmap to the printer for the
                      LCD Viewer, each second (needs port 9100)
tools/
  fetch-schema.mjs    read the SGD catalogue over port 9100
  build.mjs           bundle, inline and pack everything
  upload.mjs          CISDFCRC16 file upload
  lcd-shot.mjs        save the LCD framebuffer as a PNG (needs port 9100)
  zpl-manual-extract.mjs  split the ZPL guide's text into one record per
                      command, to check zpl-reference.mjs against
  sgd-manual-extract.mjs  the same for its SGD chapters and
                      sgd-reference.mjs
test/                 unit tests: the ZPL model, the helper-file
                      parser and the other pure logic
  live/               every mode, in Chrome, against a real printer
docs/printer-notes.md what the printer does, measured
reference/            the ZPL, CPCL and EPL2 programming manuals (and
                      zpl-zbi2-pg-en.txt, the ZPL one as searchable text)
```

## Working on it

`make` lists shortcuts for everything below -- `make deploy IP=...`,
`make test`, `make test-live`, `make check` before a commit -- with the
printer taken from `test/live/config.json` when `IP` is not given.

`make release` packs the committed source (HEAD, not uncommitted
changes, which it warns about) into `dist/<name>-<version>.tar.gz` --
`monochrome-unicorn-0.43.1.tar.gz`, unpacking into a directory of the
same name. It is what `git archive` gives, so nothing untracked goes in
(`node_modules`, `dist`, `data/sgd-schema.json`, the live tests'
`config.json` and its password), and it leaves out the Zebra reference
material, `docs/initial_claude_prompt.txt` and `AGENTS.md`. Unpacked
elsewhere, `npm install` then `./deploy.sh <printer-ip>` builds and
installs it.

```sh
node test/zpl.test.mjs      # ZPL generation/parsing round-trips
node test/printer.test.mjs  # helper-file parsing and entity decoding
node test/state.test.mjs    # which interface's IP the header shows
node test/build.test.mjs    # helper-file packing, and the packed page
node test/lcd.test.mjs      # reading lcd_display_helper.sh's frames
node test/wysiwyg.test.mjs  # the designer's rulers
node test/zplhelp.test.mjs  # the source view's command reference
node test/sgdref.test.mjs   # the setting reference, against the catalogue
node test/history.test.mjs  # the Label Editor's undo history
node test/shortcuts.test.mjs # the shortcut sheet's list
node test/gallery.test.mjs  # what a rename may call a picture
node test/sensor.test.mjs   # the media sensor gauges
node test/layers.test.mjs   # reordering layers
node test/store.test.mjs    # the state store
node test/filewrite.test.mjs # file.append requests, chunks and text encodings
node test/syslog.test.mjs   # syslog lines, destinations and alerts
npm test                    # all of the above
node tools/build.mjs        # build without touching a printer
npm run format              # lay out every .js/.mjs with prettier
npm run test:live           # every mode, in Chrome, against a real printer
```

### The live tests

`test/live/` drives the deployed console in a real browser against a
real printer -- no mocks. It asks for the printer's address and
password, whether it may print labels, and what label is loaded
(defaulting to what the printer reports), then builds and deploys this
working tree and runs a suite per mode: the app shell, Printer
Settings, Label Editor, Stored Formats, File System and LCD Viewer.

```sh
npm run test:live                            # asks, and offers to save the answers
npm run test:live -- --yes                   # no questions: test/live/config.json
npm run test:live -- --only editor,files --no-deploy --headed
```

`test/live/config.example.json` shows the config file; the real one,
`test/live/config.json`, is ignored by git since it holds the password.
It needs Chrome (`--chrome` for another path), and the `dd`, `od` and
`awk` the LCD helper uses.

What the tests create is named `ZTEST*` and removed again, and what they
change (`device.user_p1`, the menu on the screen) is put back. Printer
Settings tests its editors on settings made for the purpose with
`device.user_vars.create` -- `device.user_vars.test_string`,
`test_integer`, `test_double` and `test_choices` -- which the printer
cannot delete: they last until it is next power cycled, and the
catalogue deployed by the run lists them until the next deploy after
that. Nothing is printed unless you said so.

**Every new feature gets live tests.** When a mode gains something a
person can do, add a test for it to that mode's `test/live/*.live.mjs`
(or a new suite, registered in `test/live/run.mjs` and
`test/live/lib/config.mjs`) in the same change: drive it through the
page as a person would, and check the result on the printer itself over
port 9100 or plain HTTP (`test/live/lib/printer.mjs`), not just in the
DOM.

All JavaScript is formatted by [prettier](https://prettier.io), with the
settings in `.prettierrc.json` — the sources, the tools and the tests,
and the JS the build embeds in `INDEX.SHTML` too: the build strips the
comments from the bundled app, then runs it and the page shell's inline
`<script>` back through prettier. The embedded copy is indented with tabs
rather than two spaces, which is still prettier's layout; packed, the
layout costs next to nothing, and the code is as readable in devtools as
in the source. The one exception is `vendor/htmx.min.js`, which is
inlined minified as it ships.
The pre-commit hook refuses a staged `.js` or `.mjs` that prettier would
change.

`tools/build.mjs` contains a deliberately small ES-module bundler rather
than a dependency. It only understands `import { a, b } from './mod.js'`
and `export function|const|class`, and it rejects anything else instead
of emitting something subtly wrong. Because every module ends up sharing
one scope, it also **rejects duplicate top-level names across modules** —
without that check a collision only shows up as a `SyntaxError` in a
browser you may not have devtools on.

There is no UI framework: panels are built with `el()` (`ui.js`) and
redrawn whole. What keeps them in step is `store.js`, about 70 lines: a
mode keeps its state in a store, says what changed with a reason
(`editorStore.update('edit')`), and each view subscribes once to the
reasons it cares about -- so a new way of changing the label cannot
forget to tell the layers, the history or the preview. The Label Editor
and Stored Formats work this way; the other modes have one panel each
and redraw it directly. (React was considered and left out: about 45 KB
gzipped and a JSX compiler, for what this gives at no cost, and the
canvas's drags would still be hand-written DOM code.)

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
- The canvas approximates text width and barcode size. Font 0 is drawn
  in Inter Bold, fitted to the printer's own render and fetched from a
  CDN the first time the canvas opens (Helvetica/Arial without
  internet); the bitmap fonts are only a monospace stand-in. The preview
  is authoritative — check it before printing.
- `^IM` places a stored image at its own size; there is no scaling.
- Uploaded images are reduced to one bit per pixel, because that is all
  a thermal printer stores. The dialog shows the result before sending,
  with a dither option that helps photographs and hurts line art.
- Without `lcd_display_helper.sh` running, the LCD Viewer shows
  characters, not pixels, for the reason above. With it, the screen can
  be up to a second or two behind the printer. The viewer
  polls only while its tab is on screen and the browser tab is visible,
  so it does not compete with the rest of the console for the printer's
  single-request-at-a-time web server.
- `/dir` answers in 0.14 s but reports any type the web server does not
  know as `---`, losing the extension that decides what can be done with
  a file, and it covers one drive per request. The File System mode
  therefore reads `file.drive_listing` instead: one nine-second read
  with the real names, sizes, dates and all three drives, during which
  the printer answers nothing else. Any other request the console makes
  meanwhile waits for it to finish instead of failing with the printer's
  "busy processing another request".
- What the console can put **on** the printer: a `.ZPL` through the
  label form, a picture as a `.GRF` (reduced to one bit here in the
  browser), and anything else that has no NUL byte through `file.append`
  (docs/printer-notes.md). A file with a NUL -- a `.PNG`, a `.TTF`, a
  `.NRD` from elsewhere -- ends at the first one written that way, so it
  needs the `CISDFCRC16` header on port 9100, which a page cannot open;
  `tools/upload.mjs` does that from a computer on the network, and the
  upload dialog says so with the command filled in. An `.SHTML` written
  from the browser is served raw, its `#exec`s not run, so the helper
  files still go up with `deploy.sh`.
- Reading a file: `.ZPL` comes back from the label form, and `.BAT`,
  `.WML`, `.TXT`, EPL and CPCL formats, `.SHTML` and graphics can be
  fetched as themselves -- which is what Edit and Stored Formats read --
  but the web server answers 500 for a `.NRD` or a `.TTF`, so those can
  be replaced but not edited.
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
commit the build came from; `make release` packs exactly that.

Third-party code, all AGPL-compatible and under its own terms:

- [htmx](https://htmx.org) 2.0.4 (`vendor/htmx.min.js`), inlined into the
  build — Zero-Clause BSD.
- [Tailwind CSS](https://tailwindcss.com) (build-time only; the generated
  CSS is inlined) — MIT.
- [Ace](https://ace.c9.io), fetched from cdnjs at runtime when the source
  editor opens, never redistributed here — BSD 3-Clause.
- [Inter](https://rsms.me/inter/) Bold, the designer's stand-in for ZPL
  font 0, fetched from jsdelivr (`@fontsource/inter`) at runtime, never
  redistributed here — SIL Open Font License 1.1.

The Zebra manuals under `reference/` are Zebra Technologies' documents,
included for reference only and not covered by this licence; they are
kept out of the repository by `.gitignore`.
