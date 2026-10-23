# The telemetry server

What counts deployments. After each successful upload, `tools/deploy.mjs`
(so `./deploy.sh` and the standalone installer) POSTs one JSON report to
`https://www.grizzlor.org/monochrome-unicorn/telemetry`:

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
Needs Python 3.10 or later and systemd 219 or later (Amazon Linux 2 has
219). As root, from this directory:

```sh
# A user of its own, and the code in /opt
useradd --system --no-create-home --shell /usr/sbin/nologin mu-telemetry
mkdir -p /opt/mu-telemetry
cp server.py requirements.txt /opt/mu-telemetry/
python3 -m venv /opt/mu-telemetry/venv
/opt/mu-telemetry/venv/bin/pip install -r /opt/mu-telemetry/requirements.txt

# Where the log goes
mkdir -p /var/lib/mu-telemetry
chown mu-telemetry: /var/lib/mu-telemetry

# The service. A copy, not a link to a checkout: root runs what is in it.
install -m 644 -o root -g root mu-telemetry.service /etc/systemd/system/
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
curl -i -X POST https://www.grizzlor.org/monochrome-unicorn/telemetry \
  -H 'Content-Type: application/json' \
  -d '{"model":"test","serial":"test","firmware":"test","version":"0.0.0"}'
# HTTP/1.1 204 No Content
tail -1 /var/lib/mu-telemetry/telemetry.jsonl
```

Delete that test line from the log afterwards if it should not count.

Deploys send to `https://`, so serial numbers do not cross the internet
in clear text, and the `location` is only needed in the port-443
`server { }` block. Having it in the port-80 one too does no harm, and
serves anyone who points `MONOCHROME_UNICORN_TELEMETRY_URL` at
`http://`; if that block redirects to https://, the `location` must
come ahead of the redirect, since a client that follows one turns the
POST into a GET, which this URL refuses.

After changing `server.py`, copy it to `/opt/mu-telemetry/` again and
`systemctl restart mu-telemetry`.

## The summary page

`https://www.grizzlor.org/monochrome-unicorn/telemetry/summary` shows
the log counted: deploys, distinct printers and senders, by version,
model, firmware and month, and the latest 50 (`?recent=200` for more).
It asks for a user name, `admin`, and the password in
`/etc/mu-telemetry.env`, which only root can read:

```sh
# Once, as root: a random password
umask 077
echo "TELEMETRY_PASSWORD=$(openssl rand -base64 18)" > /etc/mu-telemetry.env
systemctl restart mu-telemetry

cat /etc/mu-telemetry.env        # to see it
```

Change it by editing that file and restarting the service. With no
password set, the page is not there (404). The `location` for it, the
third part of `nginx.conf`, goes in the port-443 `server { }` only, so
the password never crosses the internet in clear text.

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
