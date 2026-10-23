# The telemetry server

What counts deployments, and which printers they fail on. Each deploy
that uploads -- `tools/deploy.mjs`, so `./deploy.sh` and the standalone
installer -- POSTs two JSON reports to
`https://www.grizzlor.org/monochrome-unicorn/telemetry`, sharing a
random `deploy_id`: one as it starts, and one as it ends, saying whether
it worked and, if not, the step that failed:

```json
{"model": "ZM400", "serial": "40J0001", "firmware": "V53.17.11Z", "version": "0.53.0", "event": "start", "deploy_id": "612fdd60fc96a70e"}
{"model": "ZM400", "serial": "40J0001", "firmware": "V53.17.11Z", "version": "0.53.0", "event": "end", "deploy_id": "612fdd60fc96a70e", "ok": false, "step": "schema"}
```

Before 0.53 a deploy sent one report, with only the first four fields,
and only once it had worked; those are still taken, and count as
deploys that worked. This server adds the time and the sender's
address, and appends each report to a log as a line:

```json
{"ts": "2026-10-23T05:52:02+00:00", "ip": "203.0.113.9", "model": "ZM400", "serial": "40J0001", "firmware": "V53.17.11Z", "version": "0.53.0", "event": "start", "deploy_id": "612fdd60fc96a70e"}
```

It refuses an unknown field, a missing one, or a value outside what a
deploy sends (422), so nothing else can end up in the log. `--no-telemetry`, `MONOCHROME_UNICORN_NO_TELEMETRY=1`
or the installer's checkbox stop a deploy from sending, and
`MONOCHROME_UNICORN_TELEMETRY_URL` sends it somewhere else.

A failed deploy can also send its diagnostic log, if the user says so
(the main README, "When a deploy fails"): `POST` to `.../telemetry/log`
with `{"deploy_id", "version", "log"}`, a megabyte of text at most. The
server keeps it as a file of its own and notes it in the log:

```json
{"ts": "2026-10-23T05:53:10+00:00", "ip": "203.0.113.9", "event": "log", "deploy_id": "612fdd60fc96a70e", "version": "0.54.0", "bytes": 48211, "file": "20261023T055310Z-612fdd60fc96a70e.log"}
```

and answers `{"reference": "612fdd60fc96a70e"}`, the deploy's ID, for
the user to quote.

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

# Where the log goes, and the diagnostic logs
mkdir -p /var/lib/mu-telemetry/logs
chown -R mu-telemetry: /var/lib/mu-telemetry
chmod 700 /var/lib/mu-telemetry/logs

# The service. A copy, not a link to a checkout: root runs what is in it.
install -m 644 -o root -g root mu-telemetry.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mu-telemetry
curl http://127.0.0.1:8701/telemetry/health        # "ok"
```

Then nginx. `nginx.conf` here has two parts: the `limit_req_zone` lines
go in the `http { }` block (`/etc/nginx/nginx.conf`, or a new file in
`/etc/nginx/conf.d/`), and the `location` block goes inside the existing
`server { }` for www.grizzlor.org, beside its other locations (the
diagnostic logs' `location = .../telemetry/log` with the others, and its
`location ^~ .../telemetry/log/` for reading them in the port-443 one
only, as for the summary). Then:

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
the log as deploys, each start paired with its end. **Summary** has the
totals (deploys, succeeded, failed, printers, senders), the deploys that
worked by version, model, firmware and month, and the latest 50 of all
of them, each with its outcome (`?recent=200` for more). **Failed**
(`?view=failed`) has only the ones that did not work -- failed at a
step, or never finished (no end within 15 minutes) -- counted by model
and firmware, by step and by version, and listed.
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

## Diagnostic logs

Each is a file in `/var/lib/mu-telemetry/logs/`, named for when it came
and the deploy it belongs to, readable only by the service (and root).
In the summary's **Failed** view a deploy that sent one has a **log**
link after its outcome, behind the same password; logs from deploys
that sent no telemetry are listed under the table. By hand:

```sh
ls -lt /var/lib/mu-telemetry/logs/ | head
less /var/lib/mu-telemetry/logs/*-612fdd60fc96a70e.log      # by reference
```

They hold what a user's printer said -- its address, serial number and
settings listing, with secret-looking values taken out before sending --
so delete each once it has served its purpose. Together they are kept
under 500 MB: past that the server refuses more (507) until some are
deleted. `TELEMETRY_LOGS` and `TELEMETRY_LOG_LIMIT` (bytes) in
`/etc/mu-telemetry.env` move or resize that.

## Reading the log

The summary page does this for you; by hand, with `jq`
(`yum install jq`). Each deploy is a start and an end now, so pick one:

```sh
LOG=/var/lib/mu-telemetry/telemetry.jsonl
STARTS='select(.event == null or .event == "start")'   # one per deploy (and old reports)
WORKED='select(.event == null or .ok == true)'
FAILED='select(.ok == false)'

jq -c "$STARTS" $LOG | wc -l                                   # deploys
jq -c "$WORKED" $LOG | wc -l                                   # that worked
jq -r "$WORKED | .version" $LOG | sort | uniq -c | sort -rn    # by version
jq -r "$WORKED | .model" $LOG | sort | uniq -c | sort -rn      # by model
jq -r "$WORKED | .serial" $LOG | sort -u | wc -l               # distinct printers
jq -r "$FAILED | \"\(.model) \(.firmware) \(.step)\"" $LOG | sort | uniq -c   # failures
tail -f $LOG                                                   # as they come in
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
