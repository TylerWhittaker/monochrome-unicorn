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
