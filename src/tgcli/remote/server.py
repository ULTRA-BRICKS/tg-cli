"""`tg-remote server --peer <name>`: the forced command of a client machine's SSH key (spec §4.1).

The peer name comes from argv, which the `authorized_keys` line fixes; the payload only has to
agree with it. The environment (`SSH_ORIGINAL_COMMAND` included) is never consulted, so nothing a
client types can change what runs. `record` and `status` are relayed to the daemon's hook socket;
this process never writes a route or a history row itself.
"""

import socket
import time
from pathlib import Path
from typing import BinaryIO, Final, TextIO

from tgcli.config.env import load_env
from tgcli.remote import config as remote_config
from tgcli.remote import protocol
from tgcli.remote.protocol import JsonObject, ProtocolError
from tgcli.tg_ctl.lock import bot_id_from_token, ctl_paths
from tgcli.version import VERSION

DAEMON_TIMEOUT: Final = 3.0
PROBE_TIMEOUT: Final = 1.0
SERVER_OPS: Final = frozenset({"hello", "record", "status"})
CAPS: Final = ["record", "status"]
_RECV: Final = 65536


def _bot_and_socket(config_dir: Path) -> tuple[str, str]:
    bot = bot_id_from_token(load_env(config_dir).get("TG_BOT_TOKEN", ""))
    if not bot:
        raise ProtocolError("INTERNAL", "this server has no TG_BOT_TOKEN, so no bot to serve")
    return bot, ctl_paths(config_dir, bot)["socket"]


def _daemon_up(socket_path: str) -> bool:
    """Connect-and-close: is anything accepting on the hook socket (the daemon sees no request)."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(PROBE_TIMEOUT)
        try:
            probe.connect(socket_path)
        except OSError:
            return False
    return True


def _read_reply_line(conn: socket.socket, end: float) -> bytes:
    data = bytearray()
    while b"\n" not in data:
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise ProtocolError("INTERNAL", "the daemon did not answer in time")
        conn.settimeout(remaining)
        try:
            chunk = conn.recv(_RECV)
        except TimeoutError as error:
            raise ProtocolError("INTERNAL", "the daemon did not answer in time") from error
        except OSError as error:
            raise ProtocolError(
                "INTERNAL", f"daemon connection failed: {error.strerror}"
            ) from error
        if not chunk:
            raise ProtocolError("INTERNAL", "the daemon closed the socket without a reply")
        data += chunk
        if len(data) > protocol.MAX_REPLY_BYTES + _RECV and b"\n" not in data:
            raise ProtocolError("INTERNAL", "the daemon reply is too large")
    line = bytes(data).split(b"\n", 1)[0]
    if len(line) > protocol.MAX_REPLY_BYTES:
        raise ProtocolError("INTERNAL", "the daemon reply is too large")
    return line


def relay(socket_path: str, message: JsonObject, op: str, timeout: float) -> JsonObject:
    """One JSON line to the daemon hook socket, one validated reply line back."""
    line = protocol.encode_line(message, protocol.MAX_REQUEST_BYTES)
    end = time.monotonic() + timeout
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        try:
            conn.connect(socket_path)
        except OSError as error:
            raise ProtocolError(
                "NO_DAEMON", f"hook socket unreachable: {error.strerror}"
            ) from error
        try:
            conn.sendall(line)
        except OSError as error:
            raise ProtocolError("INTERNAL", f"daemon write failed: {error.strerror}") from error
        raw = _read_reply_line(conn, end)
    try:
        return protocol.parse_reply(raw, op)
    except protocol.BadReply as error:
        raise ProtocolError("INTERNAL", f"daemon reply is off-contract: {error}") from error


def _hello(request: JsonObject, peer: str, config_dir: Path) -> JsonObject:
    bot, socket_path = _bot_and_socket(config_dir)
    if request["bot"] != bot:
        raise ProtocolError("BOT_MISMATCH", "this client talks to a different bot than the server")
    return {
        "ok": True,
        "v": protocol.VERSION,
        "peer": peer,
        "bot": bot,
        "version": VERSION,
        "daemon": {"up": _daemon_up(socket_path)},
        "caps": CAPS,
    }


def _status(peer: str, config_dir: Path, timeout: float) -> JsonObject:
    _, socket_path = _bot_and_socket(config_dir)
    reply = relay(socket_path, {"kind": "remote-status", "peer": peer}, "daemon-status", timeout)
    if reply["ok"] is True:
        reply["peer"] = peer
    return reply


def _record(request: JsonObject, peer: str, config_dir: Path, timeout: float) -> JsonObject:
    _, socket_path = _bot_and_socket(config_dir)
    message: JsonObject = {"kind": "remote-record", "peer": peer, "record": request}
    return relay(socket_path, message, "record", timeout)


def _answer(peer: str, stdin: BinaryIO, config_dir: Path, timeout: float) -> JsonObject:
    request = protocol.parse_request(
        protocol.read_line_bounded(stdin, protocol.MAX_REQUEST_BYTES), SERVER_OPS
    )
    settings = remote_config.resolve(config_dir)
    if settings.mode == "invalid":
        raise ProtocolError("INTERNAL", "control config is invalid; run tg-remote config check")
    if peer not in settings.machines:
        raise ProtocolError("PEER_UNKNOWN", "this peer is not in control.remote_machines")
    if request["machine"] != peer:
        raise ProtocolError("PEER_MISMATCH", "payload machine is not the authenticated peer")
    if request["op"] == "hello":
        return _hello(request, peer, config_dir)
    if request["op"] == "status":
        return _status(peer, config_dir, timeout)
    return _record(request, peer, config_dir, timeout)


def serve(
    peer: str,
    *,
    config_dir: Path,
    stdin: BinaryIO,
    stdout: BinaryIO,
    stderr: TextIO,
    daemon_timeout: float = DAEMON_TIMEOUT,
) -> int:
    """Answer one request line with one reply line; always exit 0 once a reply was written."""
    try:
        reply = _answer(peer, stdin, config_dir, daemon_timeout)
    except ProtocolError as error:
        reply = protocol.error_reply(error.code, error.detail)
    except Exception as error:  # the SSH session must still get a reply line, not a traceback
        stderr.write(f"tg-remote server: internal error: {type(error).__name__}\n")
        reply = protocol.error_reply("INTERNAL", "unexpected server error")
    try:
        line = protocol.encode_line(reply, protocol.MAX_REPLY_BYTES)
    except ProtocolError as error:
        line = protocol.encode_line(protocol.error_reply(error.code, error.detail), 4096)
    stdout.write(line)
    stdout.flush()
    return 0
