"""Deterministic offline JSON agent fixture; descriptor prevents live use."""

import json
import sys


def main():
    try:
        raw = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError()
        request = json.loads(raw)
        if request == {"action": "describe", "protocol": "call-agent-json-v1"}:
            result = {
                "protocol": "call-agent-json-v1",
                "backend": "mock",
                "ready": True,
            }
        elif type(request.get("userId")) is int and isinstance(
            request.get("transcript"), str
        ):
            result = {
                "responseText": "Mock: " + request["transcript"],
                "endCall": False,
            }
        else:
            raise ValueError()
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({"error": "INVALID_AGENT_REQUEST"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
