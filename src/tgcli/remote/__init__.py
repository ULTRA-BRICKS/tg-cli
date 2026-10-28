"""Remote ctl server: a client machine records routes on, and receives replies from, the one tg-ctl.

Stdlib-only (docs/specs/2026-10-28-remote-ctl-server.md). The TypeScript side only spawns the
`tg-remote` launcher; every rule (config, wire format, journal, SSH) lives in this package once.
"""
