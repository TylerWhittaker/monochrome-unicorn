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

### Read timings

Per-variable `#exec` costs roughly 3 ms. Two settings are pathological
and dominate everything else:

| request | time | bytes |
|---|---|---|
| all 575 readable settings, framed | 14.2 s | 47 KB |
| the same, minus the two below | ~2 s | 21 KB |
| `file.drive_listing` alone | 9.3 s | 26 KB |
| `file.dir` alone | 3.0 s | 6 KB |
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
