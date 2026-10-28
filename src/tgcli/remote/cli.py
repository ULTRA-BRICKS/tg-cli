"""`tg-remote`: argv parsing and dispatch for the remote ctl subcommands.

    config check [--json]          exit 0 ok, 78 invalid (stdout: the check document with --json)
    client record|hello|status|flush
    doctor [--json] [--no-network]
    server --peer <name>           forced command of a client key (always exits 0 once it replied)
    satellite serve                run on a client machine by the daemon host
    hub hello|deliver <machine>    run by the daemon

Exit codes follow sysexits: 64 usage, 65 bad input data, 69 peer unreachable, 74 local I/O,
75 outcome uncertain, 76 peer refused, 78 invalid or missing configuration. Imports are lazy so a
`--help` or a config check never loads the ssh/journal code.
"""

import json
import os
import signal
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import BinaryIO, Final, NoReturn, TextIO

from tgcli.remote import protocol
from tgcli.remote import result as exits
from tgcli.remote.result import Result

USAGE: Final = """\
usage: tg-remote <command>

  config check [--json]            validate control.server / machine / remote_machines
  client record                    record one sent message on the ctl server (JSON on stdin)
  client hello|status|flush        ping the server, read its status, replay the journal
  doctor [--json] [--no-network]   config, transport and journal checks of a client machine
  server --peer <name>             forced command of a client's SSH key (daemon host)
  satellite serve                  receive replies for this machine's agents (client machine)
  hub hello <machine>              probe a client machine's satellite (daemon host)
  hub deliver <machine>            deliver a reply (JSON on stdin) to a client machine

exit codes: 0 ok, 64 usage, 65 bad input, 69 unreachable, 74 local I/O, 75 uncertain,
            76 refused by the peer, 78 invalid configuration
"""


class _Io:
    """The process edges, injected so tests drive `main` without a subprocess."""

    def __init__(
        self, env: Mapping[str, str], stdin: BinaryIO, stdout: BinaryIO, stderr: TextIO
    ) -> None:
        self.env = env
        self.stdin = stdin
        self.stdout = stdout
        self.stderr = stderr

    @property
    def config_dir(self) -> Path:
        from tgcli.remote.config import config_dir

        return config_dir(self.env)

    def text(self, line: str) -> None:
        self.stdout.write(f"{line}\n".encode())

    def emit(self, body: Mapping[str, object]) -> None:
        self.stdout.write(json.dumps(body, ensure_ascii=False).encode() + b"\n")
        self.stdout.flush()

    def finish(self, result: Result) -> int:
        self.emit(result.body)
        return result.exit_code

    def usage(self, why: str) -> int:
        self.stderr.write(f"tg-remote: {why}\n\n{USAGE}")
        return exits.EXIT_USAGE

    def read_json_object(self) -> protocol.JsonObject | Result:
        """The one JSON object on stdin, or the `Result` that refuses it (exit 65)."""
        raw = self.stdin.read(protocol.MAX_REQUEST_BYTES + 1)
        if len(raw) > protocol.MAX_REQUEST_BYTES:
            return _invalid("input exceeds 1 MiB")
        try:
            doc = protocol.load_json(raw)
        except ValueError as error:
            return _invalid(str(error))
        return doc if isinstance(doc, dict) else _invalid("input must be one JSON object")


def _invalid(detail: str) -> Result:
    return Result(
        exits.EXIT_DATA,
        {"ok": False, "status": "invalid", "error": "invalid-request", "uncertain": False}
        | {"detail": detail},
    )


# --- commands ----------------------------------------------------------------------------------


def _describe(document: Mapping[str, object]) -> str:
    if document["mode"] == "client":
        return f"client of {document['server']} as {document['machine']}"
    if document["mode"] == "hub":
        machines = document["remote_machines"]
        assert isinstance(machines, list)
        return f"daemon host serving {len(machines)} client machine(s)"
    return "local (no remote ctl keys)"


def _config_check(io: _Io, args: list[str]) -> int:
    from tgcli.remote import config as remote_config

    if args not in ([], ["--json"]):
        return io.usage("config check takes only --json")
    document = remote_config.check(io.config_dir)
    if args:
        io.emit(document)
    elif document["ok"]:
        io.text(f"ok: {_describe(document)}")
    else:
        errors = document["errors"]
        assert isinstance(errors, list)
        io.stderr.write("".join(f"{error}\n" for error in errors))
    return 0 if document["ok"] else exits.EXIT_CONFIG


def _client(io: _Io, args: list[str]) -> int:
    from tgcli.remote import client

    if len(args) != 1 or args[0] not in {"record", "hello", "status", "flush"}:
        return io.usage("client needs one of record, hello, status, flush")
    directory, env, err = io.config_dir, io.env, io.stderr
    if args[0] == "hello":
        return io.finish(client.hello(config_dir=directory, env=env, stderr=err))
    if args[0] == "status":
        return io.finish(client.status(config_dir=directory, env=env, stderr=err))
    if args[0] == "flush":
        return io.finish(client.flush(config_dir=directory, env=env, stderr=err))
    body = io.read_json_object()
    if isinstance(body, Result):
        return io.finish(body)
    return io.finish(client.record(body, config_dir=directory, env=env, stderr=err))


def _doctor(io: _Io, args: list[str]) -> int:
    from tgcli.remote import client

    if not set(args) <= {"--json", "--no-network"}:
        return io.usage("doctor takes only --json and --no-network")
    result = client.doctor(config_dir=io.config_dir, env=io.env, network="--no-network" not in args)
    if "--json" in args:
        return io.finish(result)
    checks = result.body.get("checks")
    for check in checks if isinstance(checks, list) else []:
        assert isinstance(check, dict)
        io.text(f"{check['status']:<8}{check['name']}: {check['detail']}")
    errors = result.body.get("errors")
    for error in errors if isinstance(errors, list) else []:
        io.text(f"        {error}")
    return result.exit_code


def _server(io: _Io, args: list[str]) -> int:
    from tgcli.remote import server

    if len(args) != 2 or args[0] != "--peer":
        return io.usage("server needs exactly --peer <name>")
    return server.serve(
        args[1], config_dir=io.config_dir, stdin=io.stdin, stdout=io.stdout, stderr=io.stderr
    )


def _terminate(signum: int, _frame: object) -> NoReturn:
    raise SystemExit(128 + signum)


def _satellite(io: _Io, args: list[str]) -> int:
    from tgcli.remote import satellite

    if args != ["serve"]:
        return io.usage("satellite needs exactly: serve")
    # sshd hangs up the session when the daemon host gives up; unwinding (instead of dying on the
    # default action) kills the sink's process group. The ledger stays `claimed` = uncertain.
    wanted = (signal.SIGTERM, signal.SIGHUP)
    previous = {number: signal.signal(number, _terminate) for number in wanted}
    try:
        return satellite.serve(
            config_dir=io.config_dir, env=io.env, stdin=io.stdin, stdout=io.stdout, stderr=io.stderr
        )
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def _hub(io: _Io, args: list[str]) -> int:
    from tgcli.remote import hub

    if len(args) != 2 or args[0] not in {"hello", "deliver"}:
        return io.usage("hub needs: hello <machine> | deliver <machine>")
    machine, directory, env, err = args[1], io.config_dir, io.env, io.stderr
    if args[0] == "hello":
        return io.finish(hub.hello(machine, config_dir=directory, env=env, stderr=err))
    body = io.read_json_object()
    if isinstance(body, Result):
        return io.finish(body)
    return io.finish(hub.deliver(machine, body, config_dir=directory, env=env, stderr=err))


_COMMANDS: Final[dict[str, Callable[[_Io, list[str]], int]]] = {
    "client": _client,
    "doctor": _doctor,
    "server": _server,
    "satellite": _satellite,
    "hub": _hub,
}


def main(
    argv: list[str],
    env: Mapping[str, str],
    stdin: BinaryIO,
    stdout: BinaryIO,
    stderr: TextIO,
) -> int:
    io = _Io(env, stdin, stdout, stderr)
    if not argv:
        return io.usage("a command is required")
    if argv[0] in {"-h", "--help", "help"}:
        stdout.write(USAGE.encode())
        return 0
    if argv[0] == "--version":
        from tgcli.version import VERSION

        io.text(VERSION)
        return 0
    if argv[0] == "config":
        return _config_check(io, argv[2:]) if argv[1:2] == ["check"] else io.usage("config check")
    handler = _COMMANDS.get(argv[0])
    if handler is None:
        return io.usage(f"unknown command {argv[0][:40]!r}")
    return handler(io, argv[1:])


def run() -> int:
    """Entry for the launcher: the real process streams."""
    return main(sys.argv[1:], os.environ, sys.stdin.buffer, sys.stdout.buffer, sys.stderr)
