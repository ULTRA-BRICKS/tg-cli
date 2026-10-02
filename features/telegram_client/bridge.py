"""Versioned JSON stdin runner for calbot and other consumers of the same library."""

import asyncio
import json
from pathlib import Path
import sys
import signal
from contextlib import redirect_stdout

from . import call_lib
from .core import AuthStore, ClientError


async def dispatch(request, backend=None):
    if request.get("protocol") != 1:
        raise ClientError("BRIDGE_PROTOCOL_UNSUPPORTED")
    if request.get("action") == "describe":
        return {
            "protocol": 1,
            "library": call_lib.identity(),
            "actions": ["describe", "start"],
        }
    if request.get("action") != "start":
        raise ClientError("BRIDGE_ACTION_UNSUPPORTED")
    approval = request.get("consent", {})
    consent = call_lib.Consent(
        *(
            approval.get(key) is True
            for key in ("call", "provider_network", "source_idle")
        )
    )
    store = AuthStore(
        Path(request.get("store", str(Path.home() / ".local/share/tg-cli/auth")))
    )
    return await call_lib.start_conversation(
        store,
        request.get("config", {}),
        consent,
        backend=backend,
        maximum_seconds=request.get("maximum_seconds", 1800),
    )


async def serve(request):
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        return await dispatch(request)
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


def main():
    try:
        data = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ClientError("BRIDGE_REQUEST_TOO_LARGE")
        request = json.loads(data)
        if not isinstance(request, dict):
            raise ClientError("BRIDGE_REQUEST_INVALID")
        with redirect_stdout(sys.stderr):
            result = asyncio.run(serve(request))
        print(json.dumps(result))
        return 0
    except ClientError as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 3
    except (KeyboardInterrupt, asyncio.CancelledError):
        return 130
    except Exception:
        print(json.dumps({"ok": False, "error": "BRIDGE_OPERATION_FAILED"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
