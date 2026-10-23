# The telemetry server

What counts deployments. After each successful upload, `tools/deploy.mjs`
(so `./deploy.sh` and the standalone installer) POSTs one JSON report to
`http://www.grizzlor.org/monochrome-unicorn/telemetry`:

```json
{"model": "ZD500R", "serial": "40J132100037", "firmware": "V74.20.23Z", "version": "0.52.0"}
```

This server adds the time and the sender's address, and appends a line
to a log:

```json
{"ts": "2026-10-22T02:41:07+00:00", "ip": "203.0.113.9", "model": "ZD500R", "serial": "40J132100037", "firmware": "V74.20.23Z", "version": "0.52.0"}
```

It refuses anything with a field more or less (422), so nothing else
can end up in the log. `--no-telemetry`, `MONOCHROME_UNICORN_NO_TELEMETRY=1`
or the installer's checkbox stop a deploy from sending, and
`MONOCHROME_UNICORN_TELEMETRY_URL` sends it somewhere else.

```
server.py              the FastAPI app
requirements.txt       fastapi and uvicorn, pinned
mu-telemetry.service   systemd unit: uvicorn on 127.0.0.1:8701
nginx.conf             the location block that proxies to it
test_server.py         pytest telemetry/ (with pytest and httpx)
```

## Installing it on www.grizzlor.org

The server listens on 127.0.0.1 only, and nginx passes it the one URL.
Needs Python 3.10 or later. As root:

```sh
# A user of its own, and the code in /opt
useradd --system --no-create-home --shell /usr/sbin/nologin mu-telemetry
mkdir -p /opt/mu-telemetry
cp server.py requirements.txt /opt/mu-telemetry/
python3 -m venv /opt/mu-telemetry/venv
/opt/mu-telemetry/venv/bin/pip install -r /opt/mu-telemetry/requirements.txt

# The service (it makes /var/lib/mu-telemetry for the log itself)
cp mu-telemetry.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mu-telemetry
curl http://127.0.0.1:8701/telemetry/health        # "ok"
```

Then nginx. `nginx.conf` here has two parts: the `limit_req_zone` line
goes in the `http { }` block (`/etc/nginx/nginx.conf`, or a new file in
`/etc/nginx/conf.d/`), and the `location` block goes inside the existing
`server { }` for www.grizzlor.org, beside its other locations. Then:

```sh
nginx -t && systemctl reload nginx
```

and from anywhere:

```sh
curl -i -X POST http://www.grizzlor.org/monochrome-unicorn/telemetry \
  -H 'Content-Type: application/json' \
  -d '{"model":"test","serial":"test","firmware":"test","version":"0.0.0"}'
# HTTP/1.1 204 No Content
tail -1 /var/lib/mu-telemetry/telemetry.jsonl
```

Delete that test line from the log afterwards if it should not count.

**If the site redirects http:// to https://,** put the `location` in the
port-80 `server { }` block as well, ahead of the redirect (a `return 301`
in that block's own `location /` is fine; one at `server` level is
not). A client that follows a redirect turns the POST into a GET, which
this URL refuses. Better still, with HTTPS in place, change
`TELEMETRY_URL` in `tools/deploy.mjs` to `https://`, since serial numbers
otherwise cross the internet in clear text.

After changing `server.py`, copy it to `/opt/mu-telemetry/` again and
`systemctl restart mu-telemetry`.

## Reading the log

```sh
LOG=/var/lib/mu-telemetry/telemetry.jsonl
wc -l < $LOG                                         # deployments
jq -r .version $LOG | sort | uniq -c | sort -rn      # by version
jq -r .model $LOG | sort | uniq -c | sort -rn        # by printer model
jq -r .serial $LOG | sort -u | wc -l                 # distinct printers
jq -r '.ts[:7]' $LOG | sort | uniq -c                # by month
```

## Rotating it

The log grows by about 150 bytes a deploy, so it will be years before
it needs rotating. If it does, `/etc/logrotate.d/mu-telemetry`:

```
/var/lib/mu-telemetry/telemetry.jsonl {
    monthly
    rotate 120
    compress
    missingok
    notifempty
    copytruncate
}
```

The server opens the file for each report, so `copytruncate` is not
strictly needed, but it does no harm.
