"""`python -m telegram_client personal|caller <command> …` — the argv `tg` spawns."""

import sys

from .cli import main

ROLES = ("personal", "caller")

if len(sys.argv) < 2 or sys.argv[1] not in ROLES:
    print("usage: python -m telegram_client personal|caller <command> …", file=sys.stderr)
    raise SystemExit(2)
raise SystemExit(main(sys.argv[1], sys.argv[2:]))
