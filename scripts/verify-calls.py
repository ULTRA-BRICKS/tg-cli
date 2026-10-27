#!/usr/bin/env python3
"""Acceptance runner for identified calls (#761). See tests/call-integration.md.

    scripts/verify-calls.py                      hermetic suites only (default; no network/credentials)
    scripts/verify-calls.py --deployed           + read-only checks of the installed tools
    scripts/verify-calls.py --telegram           + live exact-self mirror (no call)
    scripts/verify-calls.py --tts                + one fresh neural synthesis
    scripts/verify-calls.py --call --run-id ID   + at most one call (needs --deployed --telegram --tts)

Exit 0 only if every requested check passed; 1 failed; 2 blocked; 3 not run; 64 usage error.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

if __name__ == "__main__":
    from call_acceptance.cli import main
    sys.exit(main())
