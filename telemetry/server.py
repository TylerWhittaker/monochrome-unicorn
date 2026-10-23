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

"""
server.py -- receive the deploy telemetry tools/deploy.mjs sends.

    POST /telemetry         {"model", "serial", "firmware", "version"}
    GET  /telemetry/health  "ok"
    GET  /telemetry/summary the log, counted: an HTML page behind HTTP
                            Basic auth, as $TELEMETRY_USER (default
                            admin) and $TELEMETRY_PASSWORD; with no
                            password set, it is not there at all (404)

Each report becomes one JSON line in $TELEMETRY_LOG, with the time and
the sender's address added here: the client never sends them, so it
cannot get them wrong. Behind nginx, run uvicorn with --proxy-headers
--forwarded-allow-ips=127.0.0.1 so the address is the client's, not
nginx's; telemetry/README.md has the rest.
"""

import asyncio
import json
import os
import secrets
from collections import Counter
from datetime import datetime, timezone
from html import escape
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, ConfigDict, StringConstraints

LOG_PATH = os.environ.get("TELEMETRY_LOG", "/var/lib/mu-telemetry/telemetry.jsonl")
SUMMARY_USER = os.environ.get("TELEMETRY_USER", "admin")
SUMMARY_PASSWORD = os.environ.get("TELEMETRY_PASSWORD", "")

Field = Annotated[str, StringConstraints(max_length=64)]


class Report(BaseModel):
    """What a deploy reports, and nothing else: an extra field is a 422."""

    model_config = ConfigDict(extra="forbid")

    model: Field
    serial: Field
    firmware: Field
    version: Field


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
write_lock = asyncio.Lock()


@app.post("/telemetry", status_code=204)
async def telemetry(report: Report, request: Request) -> Response:
    line = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ip": request.client.host if request.client else None,
        **report.model_dump(),
    }
    async with write_lock:
        with open(LOG_PATH, "a", encoding="utf-8") as log:
            log.write(json.dumps(line, ensure_ascii=False) + "\n")
    return Response(status_code=204)


@app.get("/telemetry/health")
async def health() -> str:
    return "ok"


basic = HTTPBasic(auto_error=False, realm="Monochrome Unicorn telemetry")


def summary_login(credentials: HTTPBasicCredentials | None = Depends(basic)) -> None:
    """Let in the one user, comparing in constant time."""
    if not SUMMARY_PASSWORD:
        raise HTTPException(status_code=404)
    ok = credentials is not None and (
        secrets.compare_digest(credentials.username.encode(), SUMMARY_USER.encode())
        & secrets.compare_digest(credentials.password.encode(), SUMMARY_PASSWORD.encode())
    )
    if not ok:
        raise HTTPException(
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="Monochrome Unicorn telemetry"'},
        )


def read_log() -> list[dict]:
    """Every report logged, oldest first; a line that will not parse is skipped."""
    try:
        with open(LOG_PATH, encoding="utf-8") as log:
            lines = log.readlines()
    except FileNotFoundError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def count_table(title: str, counts: Counter) -> str:
    rows = "".join(
        f"<tr><td>{escape(str(key) or '(none)')}</td><td class=n>{n}</td></tr>"
        for key, n in counts.most_common()
    )
    return (
        f"<section><h2>{escape(title)}</h2><table>"
        f"<tr><th>{escape(title.split()[-1].capitalize())}</th><th class=n>Deploys</th></tr>"
        f"{rows or '<tr><td colspan=2>None yet</td></tr>'}</table></section>"
    )


SUMMARY_STYLE = """
:root { --bg: #fff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --head: #f5f5f5; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151515; --fg: #e8e8e8; --muted: #9a9a9a; --line: #2e2e2e; --head: #1f1f1f; }
}
body { background: var(--bg); color: var(--fg); margin: 0 auto; max-width: 64rem;
  padding: 1.5rem 1rem; font: 14px/1.45 system-ui, sans-serif; }
h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 0 0 .5rem; }
p { color: var(--muted); margin: 0 0 1.5rem; }
.totals { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
.totals div { border: 1px solid var(--line); border-radius: 6px; padding: .6rem 1rem; min-width: 8rem; }
.totals b { display: block; font-size: 1.6rem; font-variant-numeric: tabular-nums; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1.5rem;
  margin-bottom: 1.5rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid var(--line);
  white-space: nowrap; }
th { background: var(--head); font-weight: 600; }
.n { text-align: right; font-variant-numeric: tabular-nums; }
"""


@app.get("/telemetry/summary", response_class=HTMLResponse, dependencies=[Depends(summary_login)])
async def summary(recent: int = 50) -> HTMLResponse:
    reports = read_log()
    field = lambda name: Counter(r.get(name, "") for r in reports)
    totals = [
        ("Deploys", len(reports)),
        ("Printers", len({r.get("serial") for r in reports})),
        ("Senders", len({r.get("ip") for r in reports})),
    ]
    last = reports[-1]["ts"] if reports else "never"
    totals_html = "".join(f"<div>{t}<b>{n}</b></div>" for t, n in totals)
    latest = reports[len(reports) - min(max(recent, 0), len(reports)) :]
    recent_rows = "".join(
        "<tr>"
        + "".join(
            f"<td>{escape(str(r.get(k, '')))}</td>"
            for k in ("ts", "ip", "model", "serial", "firmware", "version")
        )
        + "</tr>"
        for r in reversed(latest)
    )
    page = f"""<!doctype html>
<html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<meta name=robots content=noindex>
<title>Unicorn Deploys</title><style>{SUMMARY_STYLE}</style></head>
<body>
<h1>Monochrome Unicorn deployments</h1>
<p>From {escape(LOG_PATH)}; the latest at {escape(last)} (UTC).</p>
<div class=totals>{totals_html}</div>
<div class=grid>
{count_table("By version", field("version"))}
{count_table("By model", field("model"))}
{count_table("By firmware", field("firmware"))}
{count_table("By month", Counter(r.get("ts", "")[:7] for r in reports))}
</div>
<section><h2>The latest {len(latest)}</h2><div class=scroll><table>
<tr><th>Time (UTC)</th><th>From</th><th>Model</th><th>Serial</th><th>Firmware</th><th>Version</th></tr>
{recent_rows or '<tr><td colspan=6>None yet</td></tr>'}
</table></div></section>
</body></html>
"""
    return HTMLResponse(page, headers={"Cache-Control": "no-store"})
