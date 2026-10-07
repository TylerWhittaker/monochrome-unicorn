# What the printer actually gives you

Everything here was measured against a **ZTC ZD500R-300dpi, firmware
V74.20.23Z**, not taken from documentation. Numbers will differ on other
models; the shapes should not.

## Serving your own page

`E:INDEX.SHTML` is served at `http://<printer>/` and replaces the
built-in home page. Any `.SHTML` (or `.HTM`) on `E:` is also reachable by
name, e.g. `E:V_MEDIA.SHTML` at `/V_MEDIA.SHTML`.

Getting a file onto `E:` needs the raw print port, because the ZPL
formatter must not see the content:

```
! CISDFCRC16
0000            <- CRC, 0000 disables the check
E:INDEX.SHTML   <- destination, extension required
000203FE        <- 8 hex digits: byte count of the data that follows
0000            <- checksum, 0000 disables the check
<data>
```

Sent over `nc -C` to port 9100. `nc -C` rewrites bare LFs to CRLF on the
wire, so **the byte count must be computed after CRLF normalisation** or
the printer stores a truncated file. `tools/upload.mjs` does this.

A query string on `/` is a 500; on `/INDEX.SHTML` it is fine. Useful for
cache-busting during development, since the printer sends `Expires: 0`
but no `Cache-Control` and Chrome will still serve a stale copy.

## The SSI preprocessor

`.SHTML` and `.HTM` files are scanned for this before being served:

```html
<!--#exec cmd="/Zebra/cgi/getvar.cgi media.darkness" -->
```

The result is substituted inline. This is the **only** way to read a
setting: `getvar.cgi` is not reachable over HTTP directly (404 for
`/Zebra/cgi/getvar.cgi?media.darkness` and every variation tried).

`getvar.cgi` also accepts a whole branch (`getvar.cgi bluetooth`), which
returns a human-readable listing with a `, Choices:` suffix — the format
varies per setting, so this app frames each value itself instead:

```html
@media.darkness=<!--#exec cmd="/Zebra/cgi/getvar.cgi media.darkness" -->@
```

An unknown setting yields `?`. `allconfig` is not available this way.

**Substituted values are HTML-escaped.** Setting `device.location` to
`A&B "q" <t> 'ap'` and reading it back through the preprocessor gives:

```
@device.location=A&amp;B &quot;q&quot; &lt;t&gt; &apos;ap&apos;@
```

So `&`, `"`, `'`, `<` and `>` all come back as entities and have to be
decoded. This matters beyond display: without decoding, writing a value
containing any of them and reading it back never compares equal, and the
write looks like it failed.

### getvar.cgi stops at the first NUL byte

This is the ceiling on what the web route can return. `display.image`
(undocumented) holds the LCD framebuffer as a 240x110 1-bit BMP, whose
fifth byte is `00`, so the CGI hands back four bytes and moves on:

```
A[<!--#exec cmd="/Zebra/cgi/getvar.cgi display.image" -->]   ->  A[BM\xfd\x0d]
B[<!--#exec cmd="/Zebra/cgi/getvar.cgi comm.baud"     -->]   ->  B[115200]
```

The rest of the page still renders, so it is the value that is cut, not
the connection. No binary-valued setting can come through this route.

The same setting over the raw port works fine:

| route | result |
|---|---|
| `! U1 getvar "display.image"` | the BMP wrapped in `"` delimiters; drop the first and last byte |
| `{}{"display.image":null}` | the same bytes, escaped into JSON |
| `getvar.cgi` (HTTP) | four bytes, truncated at the first NUL |

`tools/lcd-shot.mjs` uses the first. The BMP's own `bfSize` field reads
one byte short of what is actually sent (3581 vs 3582) -- a printer
quirk that decoders ignore.

`file.capture_response` looked like a way to land the value in a file
the browser could then fetch, but it is a `do` command (not `setvar`, so
setvars.cgi cannot invoke it) and on this printer it produced no file
even when driven correctly over port 9100. ZBI would also have worked,
but `zbi.key` reads `DISABLED`.

What *does* survive is `display.text`: the same screen as a flat 120
character string, which is a 20x6 grid.

### display.text follows the menu's font

`display.text` is not a fixed 20x6 grid. It is as many columns as the
font in use fits across the panel's 240 pixels, padded row by row, with
the last row (the soft-key labels) left unpadded:

| font | columns | rows that fit |
|---|---|---|
| A.FNT (and no `<font>` tag at all) | 40 | 13 |
| B.FNT, MONOBD15.FNT | 26 | 11, 8 |
| D.FNT | 20 | 7 |
| E6.FNT | 18 | 6 |
| F.FNT | 15 | 5 |
| G.FNT | 5 | 2 |

A WML menu picks the font with `<font name="X.FNT">`, which applies to
the whole file wherever it appears. `display.load_card` names the file
on screen and follows the menus as P1/P2 links are pressed (it is
readable, whatever the manual says), so the LCD Viewer reads that file,
finds the tag, and lays the text out to match. Every font on Z: was
tried; `reference/WML/fnt-test/RESULTS.md` (kept out of the repository
with the rest of `reference/`) has the full list and screenshots.
Briefly: A, B, D, E6, F, H6, MONOBD15 and the four `N?20WGL4` fonts
draw cleanly; E8, E12, E24, G, H8, H12 and H24 draw but overflow; the
EPL fonts draw through another character map; GS, EPL6, EPL7 and
EPL300-5 draw nothing; and a font that is missing (C, E) or a stub (P
to V) falls back to A. The column counts for all of them are in
`src/js/lcd.js`.

### Getting the real screen to the page

Two ways that do not work, measured from Chrome 154 on another machine:

- **A helper serving the bitmap itself.** From the console's page
  (`http://192.168.1.81`), a fetch or an `<img>` of
  `http://localhost:8765/lcd.bmp`, or of the same server at its LAN
  address, fails outright; opened in a tab of its own, the same URL
  loads. `navigator.permissions.query({name: 'local-network-access'})`
  reads `denied`: Chrome's Local Network Access will not let an
  insecure page reach other hosts on the network, and cannot even ask.
- **Uploading a BMP as a file** would need binary over `CISDFCRC16`,
  which is what hung the printer once already (below).

What does: store the picture as a ZPL graphic. `~DGR:LCD.GRF,<total>,
<bytes per row>,<hex>` over port 9100 is plain ASCII, lands on the RAM
drive, and `/png?dev=R&oname=LCD&otype=GRF` hands it back as a 1-bit
PNG in 60 ms (1.4 KB), pixel for pixel what `lcd-shot.mjs` gets. A GRF
bit is a dark dot, top row first; the BMP is bottom-up with a 32-bit
row stride and a palette whose entry 1 is black. A missing graphic is a
404, and `^XA^IDR:LCD.GRF^FS^XZ` removes it. `lcd_display_helper.sh`
does this every second.

```
   PRINTER READY    
                    
    192.168.1.81    
                    
                    
 \xc2            ABOUT 
```

Byte `0xC2` in the status row is the home icon. Note the padding is
significant -- it is the layout -- so a parser must not trim it.

### Read timings

Per-variable `#exec` costs roughly 3 ms. One setting dominates
everything else:

| request | time | bytes |
|---|---|---|
| all 574 readable settings, framed | 14.2 s | 47 KB |
| the same, minus `file.drive_listing` | ~5 s | 21 KB |
| `file.drive_listing` alone | 9.3 s | 26 KB |
| `file.dir` alone (not in allconfig) | 3.0 s | 6 KB |
| whole `device` branch | 10.7 s | 64 KB |
| `device` split into 54 sub-branch reads | 0.7 s | 3.5 KB |
| a typical branch (`media`, `wlan`, `ip`) | 0.09–0.5 s | <8 KB |

Branch enumeration of `device` is far slower than reading its members,
which is why the helper files list settings individually.

### One file or many

Reading all 574 readable settings, measured on the bench printer:

| how | time |
|---|---|
| 32 branch files, one request each | 6.9 s |
| one file holding every setting | 3.9 s |

The difference is request overhead -- about 95 ms a time on this web
server -- not the getvar work, which is the same either way. **The SSI
preprocessor streams**: the first bytes of that one file arrive at
~120 ms and the rest follow in hundreds of small chunks as each getvar
returns, so a single request still paints values as they land rather
than freezing until the end.

The branch files are still worth keeping. A write is confirmed by
re-reading the setting, and a branch is the smallest readable thing
there is -- a value only comes back through a helper holding an #exec
for it, and `getvar.cgi` cannot be called directly (404). What that
costs depends on the branch:

| read-back | time | settings |
|---|---|---|
| `V_PRINT.SHTML` | 0.12 s | 5 |
| `V_MEDIA.SHTML` | 0.17 s | 12 |
| `V_IP.SHTML` | 0.59 s | 74 |
| `V_DEVICE.SHTML` | 0.84 s | 77 |

One file per setting would make that 0.12 s everywhere, at the price of
574 files on flash and a deploy measured in minutes. Instead the
console keeps the other 76 values the read already returned: one write
often moves its neighbours, and they have been paid for.

## Writing settings

```
POST /Zebra/cgi/setvars.cgi
Content-Type: application/x-www-form-urlencoded

media.darkness=15
```

Answers **200 with an empty body whether or not it worked** — an invalid
setting name, an out-of-range value and a successful write are
indistinguishable. The only way to know is to read the value back.

## Stored objects

| endpoint | what it does |
|---|---|
| `GET /dir?dev=E&otype=ZPL` | HTML listing; ~0.14 s, much faster than the `file.dir` SGD |
| `GET /zpl?dev=E&oname=X&otype=ZPL` | edit form; the script is in `<textarea name="data">`, HTML-escaped |
| `POST /zpl` + `prev=Preview Label` | renders to a temp bitmap, returns a page containing the `<IMG>` |
| `POST /zpl` + `print=Print Label` | prints |
| `POST /zpl` + `save=Save` + `pw=` | writes the script to the drive |
| `GET /png?dev=E&oname=X&otype=PNG` | the raw bitmap of a stored image |
| `GET /delete?dev=E&oname=X&otype=ZPL&pw=&confirm=Delete` | deletes |

Notes that cost time to discover:

- **Save and delete need the printer's 4-digit password** (factory
  default `1234`). Without it: "ERROR: Invalid password." Preview and
  print do not.
- **The preview's temp object name increments** — `__TMP001`, `__TMP004`,
  `__TMP015` — so the `<IMG SRC>` has to be read out of the response
  rather than constructed.
- **A label that draws nothing produces no bitmap.** The response still
  contains an `<IMG>`, but fetching it gives 404.
- `delete` on an `.SHTML` file does not work through the CGI (the
  directory lists the type as `---`). Use ZPL instead:
  `^XA^IDE:NAME.SHTML^FS^XZ` over port 9100.
- Errors are marked up as `<B>ERROR:</B> message.` inside the page.
- **`/png` drops the first four bytes of a stored `.PNG`.** What arrives
  starts at `0d 0a 1a 0a`, i.e. the back half of the PNG signature, so
  no browser will render it. Putting `89 50 4e 47` back in front gives a
  valid file. A stored `.GRF` is a different path -- the printer
  converts it to PNG and that one is correct.

## Uploading a graphic from a browser

`~DY` stores a graphic, and the only way a browser can reach the ZPL
parser is the `/zpl` form. Use the **preview** action: it runs the
parser without feeding a label, so nothing is printed and no media is
used.

```
POST /zpl
data=~DYE:LOGO,A,G,<totalBytes>,<bytesPerRow>,<ASCII hex>
dev=R&oname=UNKNOWN&otype=ZPL&prev=Preview+Label
```

The ASCII hex form (`b=A`) matters: the payload travels as a urlencoded
form field, so it has to be printable. Verified storing and rendering a
200x120 graphic this way.

The same trick does **not** work for a PNG: `~DYE:NAME,A,P,<len>,,<hex>`
returns no error and stores nothing. So the browser has to do the
one-bit conversion itself and send a `.GRF`.

`~DY` reports nothing either way, so confirm by looking for the object
in `/dir` afterwards.

## Label languages other than ZPL

This printer reports `device.languages = hybrid_xml_zpl`, with choices
`zpl, hybrid_xml_zpl, epl_zpl, epl`. No CPCL (it is a desktop printer;
CPCL is the mobile line) and `apl.enable` offers only `none`, so no
downloadable emulation is installed. The console does not assume ZPL
anywhere, but what it *can* do still varies by language, entirely
because of what the web server will hand over:

|                              | ZPL | EPL | CPCL (.FMT/.LBL) |
|---|---|---|---|
| listed by `/dir`             | yes | yes | yes, but as type `---` |
| real extension visible       | `/dir` | `/dir` | only `file.drive_listing` |
| contents readable over HTTP  | **yes** | no | no |
| preview renders it           | **yes** | no | no |
| accepted by `POST /zpl`      | yes | yes | yes (ignored here) |

Three findings worth keeping:

- **`/zpl` only opens `.ZPL` objects.** Asked for any other type it
  answers "The printer is busy processing another request. Please try
  again later." regardless of how idle it is. That is a type refusal
  wearing a misleading message; a `.ZPL` read in the same second works.
- **`/dir` loses the extension of a type it does not know.** A file
  uploaded as `E:SHELF.FMT` is listed as `E:SHELF.---`. The real name
  survives in `file.drive_listing`, which is the only way to find CPCL
  formats from the browser -- and that read takes about nine seconds.
- **`file.type` reads any file, but only over port 9100.** Setting it
  through `setvars.cgi` returns an empty body: the contents go to the
  port the command arrived on, and for HTTP that is nowhere. Reading it
  back through the SSI preprocessor gives `"?"`.
- **A file on E: is served at `/NAME.EXT`** — which is how the helper
  files work, and it turns out to be general. `GET /FF.BAT` returns the
  batch file, `GET /LOGO.PNG` the whole graphic (unlike `/png`, which
  drops four bytes). Not everything: `.NRD` and `.TTF` answer 500, and
  a wrong extension is a 404. This is the only way to read anything
  that is not a `.ZPL`.
- **A stored `.ZPL` is tokenized on disk.** Fetched as a file it comes
  back with `^` as `0x1e`, `,` as `0x1f` and no line breaks at all; the
  `/zpl` form is what reassembles it. `detokenizeZpl` undoes it.

### Filling in a stored format, per language

| | recall | fields |
|---|---|---|
| ZPL | `^XA ^XFE:NAME.ZPL^FS` then `^FNn^FD…^FS` per field, `^XZ` | named `^FN`, order free |
| EPL | `FR"NAME"` then `?`, one line per variable, then `Pn` | `V00`-`V99`, declared in order, prompts included |
| CPCL | `! UF NAME.FMT` then one line per placeholder | `\\` placeholders, positional, unnamed |

EPL's `V` command carries the prompt it would have shown on a keyboard
unit (`V00,15,N,"Enter Product Name:"`), which makes a far better field
label than a number. CPCL placeholders have no names at all, so the
console labels each with the command line it sits in.

## Reading a file over HTTP

- **The path namespace is flat.** `/NAME.EXT` serves a stored file from
  whichever drive holds it, ROM included: `GET /BLUETOOTH.WML` returns
  the 7881-byte ROM file. There is no `dev` in the path, so where two
  drives hold the same name the printer chooses.
- Which *types* it will part with is a separate question and only the
  request answers it: `.WML`, `.BAT`, `.PNG`, `.BMP`, `.ZPL` and
  `.SHTML` come back; `.FNT`, `.TTF` and `.NRD` answer 500.
- **`file.type` returns nothing over HTTP**, retested every way there
  is: through `setvars.cgi`, read back through the preprocessor (`"?"`),
  called as `getvar.cgi?file.type` (404 -- the CGI is only reachable
  through an SSI `#exec`), and from inside a `file.run` script. The
  contents go to the port the command arrived on, and an HTTP request
  is not one.
- **`setvars.cgi`'s results page is not evidence.** It answers
  `name->value SUCCEEDED` for an ordinary setting, and `FAILED` for
  every write-only one -- including a `file.delete` that demonstrably
  deleted the file. Only what changed proves anything.

## Running commands from the browser

`file.run` feeds a stored file to the parser exactly as if it had been
sent to port 9100, which is a way out of nearly every CGI limitation.
The chain needs no password and no socket, and all three links are
measured:

1. `~DYR:NAME,A,B,<len>,,<raw text>` stores the data field **verbatim**
   (the `A`/`B` pair does no hex decoding), so the browser can write an
   arbitrary byte stream through the `/zpl` preview form.
2. `setvar file.run R:NAME.BMP` executes it. A stored `~DY` ran and
   created its object; `! U1 setvar` lines work too (a `file.delete`
   inside a script removed a file).
3. A `! CISDFCRC16` header inside such a script writes **any filename
   with any extension, byte for byte** -- `E:HELLO.TXT` was created
   from the browser and served back identical. (It has not been reproduced
   since, and failed attempts wedge port 9100: see "What a browser can
   upload" below.) That is the header
   `tools/upload.mjs` uses on port 9100, and it is what the console
   would need to upload a `.BAT`, `.EPL` or `.FMT`.

Two things that do **not** work:

- **Binary payloads hang the printer.** A `CISDFCRC16` body containing
  NUL bytes, sent through the `/zpl` form, left the printer accepting
  TCP connections on both ports and answering neither -- the signature
  of a download header still waiting for bytes the form truncated.
  Flushing 300 KB, `CAN` (0x18) and `~JA` did not clear it; only a
  power cycle did. Keep these payloads to printable ASCII.
- **`file.capture_response` captures nothing here**, with or without a
  filename, whether begun inside the `file.run` script or over HTTP
  either side of one. There is no read-back channel: `file.run` writes
  and executes, and that is all.

## The file.* command settings

These three are write-only SGDs that make the printer do something, and
unlike `file.type` they work perfectly well through `setvars.cgi` --
nothing has to come back:

| setting | value | what it does |
|---|---|---|
| `file.print` | `E:NAME.ZPL` | prints a stored format |
| `file.run` | `E:NAME.BAT` | runs a stored batch file |
| `file.delete` | `E:NAME.EXT` | deletes, **without the password** |

`file.delete` is the better of the two delete routes: the `/delete` CGI
wants the password and still refuses some types -- `E:X.NRD` answers
"could not be queued for deletion", and the SGD removes it without
complaint. Neither reports success, so confirm with `/dir`.

## What a browser can upload

Only two things, both through the `/zpl` form:

| payload | how | result |
|---|---|---|
| ZPL text | `save=Save` + `pw=` | stored as `.ZPL` |
| 1-bit graphic | `~DY...,A,G,...` hex, preview action | stored as `.GRF` |

Everything else was tried and does not work:

- **`save=Save` ignores `otype`.** Posting with `otype=TXT` stores
  `E:NAME.ZPL`, and the text is run through the ZPL formatter on the
  way in -- 26 bytes of prose arrived as a 5-byte file.
- **`! CISDFCRC16` through the form does nothing.** The header that
  works on port 9100 (and is how `tools/upload.mjs` writes `.SHTML`)
  stores nothing when it arrives as the `data` field, with CRLF or LF.
- **`~DY` parses its extension parameter by first letter**, whatever
  the manual's table implies: `x=BAT` stored `.BMP`, `x=TXT` stored
  `.TTF`, `x=EPL` stored `.TTE`. `NRD` is matched whole. So `.BAT`,
  `.TXT`, `.EPL`, `.FMT` and `.LBL` cannot be written from a browser
  at all.
- **`~DY` still will not store a `.PNG`**, in any of the three
  encodings: `A` with ASCII hex, `A` with `:B64:`, `P` with `:B64:`.
  No error, no file. (`:B64:` does work for the types that store at
  all, and a CRC of `0000` is accepted.)
- **`~DY`'s WML type (`x = C`) stores nothing**, though the manual
  lists it beside `F` (.HTM) and `H` (.GET). Tried 2026-10-03 on a
  ZD500R (V74.20.23Z) and a ZD620 (V84.20.23Z), through the `/zpl` form
  and on port 9100 alike, as `A` with ASCII hex, `B` with the raw text
  and `A` with `:B64:`, with and without `.WML` in the name: no error,
  no file, a 404 for `/NAME.WML`.
- **The `file.run` chain above is not safe to build on**, retested
  2026-10-03/04 on the ZD500R with a `.TXT` and a `.WML`. Every failure
  left port 9100 accepting connections and answering nothing (HTTP
  carried on) until a power cycle -- four of them:
  - **The form strips trailing line breaks from `data`.** A `~DY` whose
    data ends in CRLF arrives two bytes short; it is stored only when
    the next request's bytes complete it. A `~DY` or `CISDFCRC16` left
    short is what wedges the parser.
  - **Appending `^XA^XZ` after the data does not cure it**: that
    request answered HTTP 400, stored nothing, and wedged 9100 anyway.
  - **Files on R: are not served over HTTP** (`/NAME.BMP` is a 404 even
    while `/dir` lists it), so a page cannot check a stored script
    before running it.
  - Node's `fetch` gets HTTP 400 from `/zpl` where curl and browsers
    get 200; test with curl.

  Uploads other than `.ZPL` and `.GRF` stay with `tools/upload.mjs` on
  port 9100.

## Printers older than Link-OS

A printer running firmware below **V68** predates Link-OS and has no
JSON channel at all, so `{}{"allconfig":null}` gets nothing back. `~HI`
says which generation a printer is:

```
~HI  ->  \x02ZD500R-300dpi,V74.20.23Z,12,4096KB,CUTTER DETECTED\x03
```

The second field is the firmware version; the number after the `V` is
what decides. The build picks the catalogue command from that, and
`./deploy.sh <ip> --allcv` (or `--allconfig`) forces it either way.

### allcv

`! U1 getvar "allcv"` works on every printer, Link-OS included, which
is how this was tested without a pre-Link-OS one to hand. It answers
with a flat listing:

```
bluetooth.                                       <- category marker
bluetooth.discoverable : off , Choices: on,off   <- value and choices
bluetooth.friendly_name : 40J132100037           <- value only
bluetooth.clear_bonding_cache                    <- no value at all
ip.netstat : Active Internet connections         <- value carries on
Proto Recv-Q Send-Q  Local Address ...              over more lines
```

Things that cost time to discover, all measured on the bench ZD500R:

- **It ends with a quote character alone on a line, with no line ending
  after it** -- and that printer sends `""`, not `"`. A quote can also
  be the last line of a multi-line value, so seeing one is not proof:
  wait five seconds for more data before believing it.
- **A value may run over any number of lines** (`ip.netstat` runs to 34,
  `file.dir` to 192), and a continuation line can look like anything.
  Only a line that starts at column zero with a dotted lower-case name
  begins a new setting.
- **Choices are not access flags.** Of the 581 settings listed by both
  allcv and allconfig on the same printer, 206 of the 208 with choices
  were read/write -- but of the 318 with a value and no choices, 195
  were read-only and **111 were writable**. Neither "no choices means
  read-only" nor the reverse is true, so the console marks those
  `RW?`: editable, tagged as a guess, and confirmed by the read-back
  every write does anyway.
- **allcv lists more than allconfig**: 737 settings against 647, and it
  includes `file.dir`, which allconfig hides and which takes three
  seconds to read. That one is added to the slow list so it does not
  join the `file` branch sweep.
- **No factory defaults.** Nothing is marked as changed from default on
  an allcv catalogue, and the Settings tab says why rather than leaving
  a column mysteriously empty.

## The front panel, from the browser

`diag.simulate_event` presses the printer's own buttons. It is in no
catalogue -- neither allconfig nor allcv lists it -- but a getvar
answers `""` rather than `"?"`, which is how an existing write-only
setting replies, and it works through `setvars.cgi` like the other
command settings.

```
! U1 setvar "diag.simulate_event" "ButtonP1:Set"
```

Verified on a ZD500R: `ButtonP1`, `ButtonP2`, `ButtonSelect`,
`ButtonUp`, `ButtonDown`, `ButtonLeft`, `ButtonRight` and
`ButtonPause`. P1 opens SETTINGS from the home screen, Select enters an
item, and **Up and Down change the value**, not just the highlight --
this drives the printer, it does not browse it.

The value is exact. `do` instead of `setvar`, lower case, a missing
`:Set`, or `PAUSE:Set` without the `Button` prefix: all do nothing,
silently. And a press that does nothing is not proof the command
failed -- Down does nothing on the home screen, which is what made the
first attempt look like a dead end.

## Rendering

`^PW` and `^LL` both take effect in the preview; width is rounded up to a
byte boundary (`^PW900` renders 960 px wide). `^IME:NAME.PNG` places a
stored PNG. Code 128/39/93, I2of5, EAN-13, UPC-A, QR, Data Matrix,
PDF417 and Aztec all render. `^XF` recall with `^FN`/`^FD` fill works on
a plain `.ZPL` file — it does not have to have been stored with `^DF`.

## Throughput

About 56 KB/s, whether or not the file goes through the preprocessor
(a 480 KB page takes 8.3 s). This is the reason the built page is kept
near 200 KB and Ace is loaded from a CDN instead of inlined.

The server sends no `Content-Encoding`, and there is no way to give an
`.SHTML` one, so the build compresses the page itself: CSS, htmx, the
app and the catalogue gzipped together and carried as base64 (wrapped at
120 characters, in case the preprocessor minds long lines), unpacked in
the browser with `DecompressionStream`. 437 KB became 167 KB; on a wired
ZD500R the page went from 1.1 s to 0.6 s.
