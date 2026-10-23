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
