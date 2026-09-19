# Zebra printer console

A single-page console that runs **on** a Zebra printer: the build folds
everything into one `INDEX.SHTML` and uploads it to the printer's flash,
where its onboard web server serves it at `http://<printer>/`.

Three modes:

- **Printer Settings** — every SGD on the printer, `about:config` style:
  filter by name or value, edit the writable ones with a widget chosen
  from the setting's type and range, see at a glance which differ from
  their factory default.
- **Label Editor** — create and edit stored `.ZPL` labels, either by
  dragging text, barcodes, images, boxes, lines and `^FN` fields around a
  canvas or by writing ZPL directly. The preview beside it is the
  printer's own render, not a simulation.
- **Format Printer** — pick a stored format, fill in one box per `^FN`
  field, preview and print.

## Deploying

```sh
npm install                      # once, for the Tailwind CLI
./deploy.sh 192.168.1.81
```

That reads the printer's setting catalogue, builds `dist/INDEX.SHTML`,
uploads it plus its helper files, and checks what the printer now serves.

```
--no-schema   reuse data/sgd-schema.json instead of re-reading the printer
--no-upload   build only
--clean       remove previously installed V_*.SHTML helpers first
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
575 readable settings in one page takes 14 s, almost all of it in
`file.dir` and `file.drive_listing`. So the build also emits one small
`V_<BRANCH>.SHTML` per settings branch, each listing its settings as
`@name=<!--#exec getvar.cgi name-->@`. The client reads a branch in about
0.1 s, and re-reads one after a write.

**`setvars.cgi` reports nothing.** It answers 200 with an empty body for
a successful write, an out-of-range value and a misspelt setting name
alike. Every write is therefore followed by a read-back of that branch,
and the row reports the value the printer actually kept.

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
  zpl.js              label model, ZPL generation and parsing
  wysiwyg.js          the drag-and-drop canvas
  inspector.js        label and element property panels
  codeeditor.js       Ace loader, ZPL syntax mode, offline fallback
  preview.js          the preview pane (htmx round-trip to /zpl)
  ui.js               DOM helpers, toasts, modals, password prompt
tools/
  fetch-schema.mjs    read the SGD catalogue over port 9100
  build.mjs           bundle and inline everything
  upload.mjs          CISDFCRC16 file upload
test/zpl.test.mjs     round-trip tests for the ZPL model
docs/printer-notes.md what the printer does, measured
```

## Working on it

```sh
node test/zpl.test.mjs      # ZPL generation/parsing round-trips
node tools/build.mjs        # build without touching a printer
```

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
- Images must already be on the printer. This console does not upload
  them (the browser cannot reach port 9100); use `tools/upload.mjs`.
- The setting catalogue is captured at build time. Deploying a build to
  a different printer model may show settings it does not have; re-run
  `./deploy.sh <ip>` against that printer to recapture.
