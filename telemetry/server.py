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

    POST /telemetry         {"model", "serial", "firmware", "version",
                             "event", "deploy_id", "ok", "step"}
    GET  /telemetry/health  "ok"
    GET  /telemetry/summary the log, counted: an HTML page behind HTTP
                            Basic auth, as $TELEMETRY_USER (default
                            admin) and $TELEMETRY_PASSWORD; with no
                            password set, it is not there at all (404);
                            ?view=failed for the deploys that did not work

A deploy since 0.53 reports twice, sharing a deploy_id: event "start"
before it touches the printer, and "end" with ok, and the step it
failed at when it did not. Before that, a deploy reported once, only
when it had worked, with none of those four fields.

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
from datetime import datetime, timedelta, timezone
from html import escape
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from pydantic import BaseModel, ConfigDict, StringConstraints

LOG_PATH = os.environ.get("TELEMETRY_LOG", "/var/lib/mu-telemetry/telemetry.jsonl")
SUMMARY_USER = os.environ.get("TELEMETRY_USER", "admin")
SUMMARY_PASSWORD = os.environ.get("TELEMETRY_PASSWORD", "")

Field = Annotated[str, StringConstraints(max_length=64)]

# A deploy that has not reported its end after this long never will.
UNFINISHED_AFTER = timedelta(minutes=15)


class Report(BaseModel):
    """What a deploy reports, and nothing else: an extra field is a 422."""

    model_config = ConfigDict(extra="forbid")

    model: Field
    serial: Field
    firmware: Field
    version: Field
    event: Literal["start", "end"] | None = None
    deploy_id: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{16}$")] | None = None
    ok: bool | None = None
    step: Annotated[str, StringConstraints(pattern=r"^[a-z]{0,16}$")] | None = None


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
write_lock = asyncio.Lock()


@app.post("/telemetry", status_code=204)
async def telemetry(report: Report, request: Request) -> Response:
    line = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ip": request.client.host if request.client else None,
        **report.model_dump(exclude_none=True),
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


def deploys(reports: list[dict], now: datetime | None = None) -> list[dict]:
    """
    The log as deploys, oldest first: a start and its end made one, with
    an outcome of "ok", "failed", "unfinished" (a start whose end never
    came) or "running" (one that may yet).
    """
    now = now or datetime.now(timezone.utc)
    out, by_id = [], {}
    for r in reports:
        event, deploy_id = r.get("event"), r.get("deploy_id")
        if event is None:  # before 0.53: one report, of a deploy that worked
            out.append({**r, "outcome": "ok"})
        elif event == "start" or deploy_id not in by_id:
            d = {**r, "outcome": None}
            by_id[deploy_id] = d
            out.append(d)
            if event == "end":  # an end whose start was lost
                d["outcome"] = "ok" if r.get("ok") else "failed"
        else:
            d = by_id[deploy_id]
            for key in ("model", "serial", "firmware", "version", "step"):
                d[key] = r.get(key) or d.get(key, "")
            d["ended"] = r.get("ts")
            d["outcome"] = "ok" if r.get("ok") else "failed"
    for d in out:
        if d["outcome"] is None:
            try:
                started = datetime.fromisoformat(d.get("ts", ""))
            except ValueError:
                started = now - UNFINISHED_AFTER
            d["outcome"] = "running" if now - started < UNFINISHED_AFTER else "unfinished"
    return out


def count_table(title: str, column: str, counts: Counter, unit: str = "Deploys") -> str:
    rows = "".join(
        f"<tr><td>{escape(str(key) or '(none)')}</td><td class=n>{n}</td></tr>"
        for key, n in counts.most_common()
    )
    return (
        f"<section><h2>{escape(title)}</h2><table>"
        f"<tr><th>{escape(column)}</th><th class=n>{escape(unit)}</th></tr>"
        f"{rows or '<tr><td colspan=2>None yet</td></tr>'}</table></section>"
    )


def outcome_text(d: dict) -> str:
    if d["outcome"] == "failed":
        return f"failed at {d.get('step') or 'an unknown step'}"
    return {"ok": "ok", "unfinished": "never finished", "running": "running"}[d["outcome"]]


def deploy_table(title: str, rows: list[dict]) -> str:
    body = "".join(
        f"<tr class={d['outcome']}>"
        + "".join(
            f"<td>{escape(str(d.get(k, '')))}</td>"
            for k in ("ts", "ip", "model", "serial", "firmware", "version")
        )
        + f"<td>{escape(outcome_text(d))}</td></tr>"
        for d in reversed(rows)
    )
    return (
        f"<section><h2>{escape(title)}</h2><div class=scroll><table>"
        "<tr><th>Started (UTC)</th><th>From</th><th>Model</th><th>Serial</th>"
        "<th>Firmware</th><th>Version</th><th>Outcome</th></tr>"
        f"{body or '<tr><td colspan=7>None yet</td></tr>'}</table></div></section>"
    )


SUMMARY_STYLE = """
:root { --bg: #fff; --fg: #1a1a1a; --muted: #6b6b6b; --line: #e3e3e3; --head: #f5f5f5;
  --bad: #b42318; --bad-bg: #fef3f2; --warn: #93370d; --warn-bg: #fffaeb; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151515; --fg: #e8e8e8; --muted: #9a9a9a; --line: #2e2e2e; --head: #1f1f1f;
    --bad: #fda29b; --bad-bg: #3a1714; --warn: #fec84b; --warn-bg: #33270c; }
}
body { background: var(--bg); color: var(--fg); margin: 0 auto; max-width: 68rem;
  padding: 1.5rem 1rem; font: 14px/1.45 system-ui, sans-serif; }
h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; margin: 0 0 .5rem; }
p { color: var(--muted); margin: 0 0 1rem; }
nav { display: flex; gap: .25rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--line); }
nav a { padding: .4rem .8rem; color: var(--muted); text-decoration: none;
  border-bottom: 2px solid transparent; margin-bottom: -1px; }
nav a[aria-current] { color: var(--fg); border-color: var(--fg); font-weight: 600; }
.totals { display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
.totals div { border: 1px solid var(--line); border-radius: 6px; padding: .6rem 1rem; min-width: 8rem; }
.totals b { display: block; font-size: 1.6rem; font-variant-numeric: tabular-nums; }
.totals .bad b { color: var(--bad); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1.5rem;
  margin-bottom: 1.5rem; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid var(--line);
  white-space: nowrap; }
th { background: var(--head); font-weight: 600; }
tr.failed td { background: var(--bad-bg); }
tr.failed td:last-child { color: var(--bad); font-weight: 600; }
tr.unfinished td { background: var(--warn-bg); }
tr.unfinished td:last-child { color: var(--warn); font-weight: 600; }
.n { text-align: right; font-variant-numeric: tabular-nums; }
"""


def page(view: str, body: str, last: str) -> HTMLResponse:
    tabs = "".join(
        f'<a href="?view={v}"{" aria-current=page" if v == view else ""}>{label}</a>'
        for v, label in (("summary", "Summary"), ("failed", "Failed"))
    )
    html = f"""<!doctype html>
<html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width, initial-scale=1">
<meta name=robots content=noindex>
<title>Unicorn Deploys</title><style>{SUMMARY_STYLE}</style></head>
<body>
<h1>Monochrome Unicorn deployments</h1>
<p>From {escape(LOG_PATH)}; the latest report at {escape(last)} (UTC).</p>
<nav>{tabs}</nav>
{body}
</body></html>
"""
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/telemetry/summary", response_class=HTMLResponse, dependencies=[Depends(summary_login)])
async def summary(view: Literal["summary", "failed"] = "summary", recent: int = 50) -> HTMLResponse:
    reports = read_log()
    all_deploys = deploys(reports)
    last = reports[-1].get("ts", "") if reports else "never"
    recent = max(recent, 0)
    newest = lambda rows: rows[len(rows) - min(recent, len(rows)) :]
    outcomes = Counter(d["outcome"] for d in all_deploys)
    failed = [d for d in all_deploys if d["outcome"] in ("failed", "unfinished")]

    if view == "failed":
        totals = [
            ("Failed", outcomes["failed"], "bad"),
            ("Never finished", outcomes["unfinished"], "bad"),
            ("Printers affected", len({d.get("serial") for d in failed}), ""),
        ]
        body = (
            "<p>A deploy that failed says at which step: schema (reading the printer's "
            "settings), build, clean, upload or verify. One that never finished started "
            f"and did not report back within {int(UNFINISHED_AFTER.total_seconds() // 60)} "
            "minutes: stopped, or crashed. Deploys before 0.53 reported only success, so "
            "their failures are not here.</p>"
            + totals_html(totals)
            + "<div class=grid>"
            + count_table(
                "By model and firmware",
                "Model / firmware",
                Counter(f"{d.get('model') or '?'} {d.get('firmware') or '?'}" for d in failed),
                "Failures",
            )
            + count_table(
                "By step",
                "Step",
                Counter(d.get("step") or "never finished" for d in failed),
                "Failures",
            )
            + count_table("By version", "Version", Counter(d.get("version", "") for d in failed), "Failures")
            + "</div>"
            + deploy_table(f"The latest {len(newest(failed))}", newest(failed))
        )
        return page(view, body, last)

    worked = [d for d in all_deploys if d["outcome"] == "ok"]
    field = lambda name: Counter(d.get(name, "") for d in worked)
    totals = [
        ("Deploys", len(all_deploys), ""),
        ("Succeeded", outcomes["ok"], ""),
        ("Failed", outcomes["failed"] + outcomes["unfinished"], "bad" if failed else ""),
        ("Printers", len({d.get("serial") for d in worked}), ""),
        ("Senders", len({d.get("ip") for d in all_deploys}), ""),
    ]
    body = (
        totals_html(totals)
        + "<p>The counts below are of deploys that worked.</p>"
        + "<div class=grid>"
        + count_table("By version", "Version", field("version"))
        + count_table("By model", "Model", field("model"))
        + count_table("By firmware", "Firmware", field("firmware"))
        + count_table("By month", "Month", Counter(d.get("ts", "")[:7] for d in worked))
        + "</div>"
        + deploy_table(f"The latest {len(newest(all_deploys))}", newest(all_deploys))
    )
    return page(view, body, last)


def totals_html(totals: list[tuple[str, int, str]]) -> str:
    cards = "".join(f"<div class='{cls}'>{escape(t)}<b>{n}</b></div>" for t, n, cls in totals)
    return f"<div class=totals>{cards}</div>"
