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

Each report becomes one JSON line in $TELEMETRY_LOG, with the time and
the sender's address added here: the client never sends them, so it
cannot get them wrong. Behind nginx, run uvicorn with --proxy-headers
--forwarded-allow-ips=127.0.0.1 so the address is the client's, not
nginx's; telemetry/README.md has the rest.
"""

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Annotated

from fastapi import FastAPI, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

LOG_PATH = os.environ.get("TELEMETRY_LOG", "/var/lib/mu-telemetry/telemetry.jsonl")

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
