"""The unix-socket exchange: one JSON line out, one reply line back, never past the deadline."""

import json
import time
from pathlib import Path

import pytest
from laya_fakes import FakeLaya, stale_socket

from tgcli.laya.client import Failure, exchange

REQUEST = json.dumps({"op": "predict", "message": "m", "questions": {"asks_reader": {}}}).encode()


@pytest.fixture
def sock_dir(tmp_path: Path) -> Path:
    d = tmp_path / "s"
    d.mkdir(mode=0o700)
    return d


def test_reads_one_reply_line(sock_dir: Path):
    server = FakeLaya(str(sock_dir / "a.sock")).start()
    line = exchange(server.path, REQUEST, 2.0)
    assert isinstance(line, str)
    assert json.loads(line)["result"]["answers"]["asks_reader"]["noul"] == 0.93
    assert server.requests[0]["op"] == "predict"
    server.stop()


def test_missing_socket_and_stale_socket_are_no_listener(sock_dir: Path):
    missing = exchange(str(sock_dir / "none.sock"), REQUEST, 1.0)
    assert isinstance(missing, Failure) and missing.kind == "no-listener"
    stale_socket(str(sock_dir / "stale.sock"))
    stale = exchange(str(sock_dir / "stale.sock"), REQUEST, 1.0)
    assert isinstance(stale, Failure) and stale.kind == "no-listener"
    assert "refused" in stale.detail


def test_silent_server_costs_the_budget_then_times_out(sock_dir: Path):
    server = FakeLaya(str(sock_dir / "s.sock"), mode="silent").start()
    started = time.monotonic()
    result = exchange(server.path, REQUEST, 0.3)
    assert isinstance(result, Failure) and result.kind == "timeout"
    assert 0.25 <= time.monotonic() - started < 1.5
    server.stop()


def test_server_that_closes_without_a_reply_is_a_connection_error(sock_dir: Path):
    server = FakeLaya(str(sock_dir / "c.sock"), mode="close").start()
    result = exchange(server.path, REQUEST, 1.0)
    assert isinstance(result, Failure) and result.kind == "connection-error"
    server.stop()


def test_oversized_reply_is_invalid(sock_dir: Path):
    server = FakeLaya(str(sock_dir / "h.sock"), mode="huge").start()
    result = exchange(server.path, REQUEST, 1.0)
    assert isinstance(result, Failure) and result.kind == "invalid-response"
    server.stop()
