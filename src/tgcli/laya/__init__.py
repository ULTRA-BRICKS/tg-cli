"""Laya model caller: config, trusted discovery, autostart and the unix-socket client.

Stdlib only, so `python3 -I <repo>/tg-laya ...` runs wherever the checkout is (no venv/installs).
The TypeScript `tg` calls it as a subprocess (features/cli/laya-socket.ts); this package is the
single implementation of the config rules, the socket trust checks and the timeouts
(docs/specs/2026-10-28-laya-autostart.md).
"""
