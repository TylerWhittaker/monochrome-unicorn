# Monochrome Unicorn -- a web app for Zebra thermal printers.
# Copyright (C) 2026 Tyler Whittaker
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The telemetry server: pytest telemetry/ (needs pytest and httpx)."""

import importlib
import json

import pytest
from fastapi.testclient import TestClient

REPORT = {"model": "ZD500R", "serial": "40J132100037", "firmware": "V74.20.23Z", "version": "0.52.0"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    log = tmp_path / "telemetry.jsonl"
    monkeypatch.setenv("TELEMETRY_LOG", str(log))
    monkeypatch.setenv("TELEMETRY_PASSWORD", "s3cret")
    import server

    importlib.reload(server)
    with TestClient(server.app) as c:
        c.log = log
        yield c


def lines(client):
    return [json.loads(l) for l in client.log.read_text().splitlines()]


def test_a_report_is_logged_with_the_time_and_address(client):
    res = client.post("/telemetry", json=REPORT)
    assert res.status_code == 204
    [line] = lines(client)
    assert {k: line[k] for k in REPORT} == REPORT
    assert line["ip"] == "testclient"
    assert line["ts"].endswith("+00:00")


def test_each_report_is_a_line(client):
    client.post("/telemetry", json=REPORT)
    client.post("/telemetry", json={**REPORT, "version": "0.52.1"})
    assert [l["version"] for l in lines(client)] == ["0.52.0", "0.52.1"]


@pytest.mark.parametrize(
    "body",
    [
        {**REPORT, "ip": "1.2.3.4"},
        {**REPORT, "ts": "2020-01-01"},
        {k: v for k, v in REPORT.items() if k != "serial"},
        {**REPORT, "model": "x" * 65},
        {**REPORT, "version": 52},
    ],
)
def test_anything_else_is_refused_and_not_logged(client, body):
    assert client.post("/telemetry", json=body).status_code == 422
    assert not client.log.exists()


def test_only_post(client):
    assert client.get("/telemetry").status_code == 405
    assert client.get("/telemetry/health").json() == "ok"
    assert client.get("/docs").status_code == 404


def test_the_summary_needs_the_password(client):
    res = client.get("/telemetry/summary")
    assert res.status_code == 401
    assert res.headers["www-authenticate"].startswith("Basic")
    assert client.get("/telemetry/summary", auth=("admin", "wrong")).status_code == 401
    assert client.get("/telemetry/summary", auth=("root", "s3cret")).status_code == 401


def test_the_summary_counts_the_log(client):
    client.post("/telemetry", json=REPORT)
    client.post("/telemetry", json=REPORT)
    client.post("/telemetry", json={**REPORT, "model": "<b>ZD620</b>", "serial": "OTHER"})
    res = client.get("/telemetry/summary", auth=("admin", "s3cret"))
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    page = res.text
    assert "Deploys<b>3</b>" in page
    assert "Printers<b>2</b>" in page
    assert "<td>0.52.0</td><td class=n>3</td>" in page
    assert "&lt;b&gt;ZD620&lt;/b&gt;" in page and "<b>ZD620</b>" not in page
    assert "The latest 3" in page
    one = client.get("/telemetry/summary?recent=1", auth=("admin", "s3cret")).text
    assert "The latest 1<" in one and one.count("<td>OTHER</td>") == 1
    none = client.get("/telemetry/summary?recent=0", auth=("admin", "s3cret")).text
    assert "The latest 0<" in none and "<td>OTHER</td>" not in none


def test_the_summary_of_an_empty_log(client):
    page = client.get("/telemetry/summary", auth=("admin", "s3cret")).text
    assert "Deploys<b>0</b>" in page and "None yet" in page


def test_no_password_no_summary(client, monkeypatch):
    import server

    monkeypatch.setattr(server, "SUMMARY_PASSWORD", "")
    assert client.get("/telemetry/summary", auth=("admin", "")).status_code == 404


START = {**REPORT, "event": "start", "deploy_id": "0123456789abcdef"}


def test_a_start_and_its_end_are_logged_as_sent(client):
    client.post("/telemetry", json=START)
    client.post("/telemetry", json={**START, "event": "end", "ok": False, "step": "schema"})
    start, end = lines(client)
    assert start["event"] == "start" and "ok" not in start and "step" not in start
    assert (end["event"], end["ok"], end["step"]) == ("end", False, "schema")
    # A report from before 0.53 is logged as it always was.
    client.post("/telemetry", json=REPORT)
    assert set(lines(client)[-1]) == {"ts", "ip", *REPORT}


@pytest.mark.parametrize(
    "fields",
    [
        {"event": "middle"},
        {"deploy_id": "not-hex"},
        {"step": "Upload; DROP"},
        {"ok": "perhaps"},
    ],
)
def test_the_new_fields_take_only_what_a_deploy_sends(client, fields):
    assert client.post("/telemetry", json={**START, **fields}).status_code == 422


def test_deploys_pairs_starts_with_ends():
    import server

    now = server.datetime(2026, 10, 23, 12, 0, tzinfo=server.timezone.utc)
    at = lambda minutes: (now - server.timedelta(minutes=minutes)).isoformat()
    log = [
        {**REPORT, "ts": at(60)},  # before 0.53: a success
        {**START, "ts": at(50), "deploy_id": "a" * 16},
        {**START, "ts": at(49), "deploy_id": "a" * 16, "event": "end", "ok": True},
        # The end fills in what the start could not ask the printer.
        {**START, "ts": at(40), "deploy_id": "b" * 16, "model": ""},
        {**START, "ts": at(39), "deploy_id": "b" * 16, "model": "ZM400", "event": "end", "ok": False, "step": "upload"},
        {**START, "ts": at(30), "deploy_id": "c" * 16},  # never came back
        {**START, "ts": at(1), "deploy_id": "d" * 16},  # still going
    ]
    got = server.deploys(log, now)
    assert [d["outcome"] for d in got] == ["ok", "ok", "failed", "unfinished", "running"]
    assert got[2]["model"] == "ZM400" and got[2]["step"] == "upload"
    assert got[1]["ts"] == at(50) and got[1]["ended"] == at(49)


def test_the_failed_view(client):
    client.post("/telemetry", json=REPORT)
    client.post("/telemetry", json={**START, "model": "ZM400", "firmware": "V53.17.11Z"})
    client.post(
        "/telemetry",
        json={**START, "model": "ZM400", "firmware": "V53.17.11Z", "event": "end", "ok": False, "step": "schema"},
    )
    summary = client.get("/telemetry/summary", auth=("admin", "s3cret")).text
    assert "Deploys<b>2</b>" in summary and "Succeeded<b>1</b>" in summary
    assert "Failed<b>1</b>" in summary
    failed = client.get("/telemetry/summary?view=failed", auth=("admin", "s3cret")).text
    assert 'aria-current=page>Failed' in failed
    assert "<td>ZM400 V53.17.11Z</td><td class=n>1</td>" in failed
    assert "<td>schema</td><td class=n>1</td>" in failed
    assert "failed at schema" in failed
    assert "<td>ZD500R</td>" not in failed, "a deploy that worked is not listed"
    assert client.get("/telemetry/summary?view=nope", auth=("admin", "s3cret")).status_code == 422
