# Issue 761: remaining process review fixes

Preserved the previous workers' local changes and nested supervisor acknowledgement fix.
No commits, pushes, deployment, credential access, network, Telegram, TTS, or calls.

`process.py` now uses nonblocking selectors for stdin/stdout/stderr, retains at most
4 MiB per output stream, and discards excess within the wall timeout. Timeout cleanup
closes pipes without waiting for escaped holders' EOF. `owned_processes.py` gives TERM
handlers a bounded grace period, then repeatedly freezes the current owned descendants,
KILLs them through pidfds, and reaps until there are no children, including late adoptions.

Linux-dependent safety/verifier assertions now require the cleanup capability. A separate
unavailable-capability regression proves claims and all four live stages are blocked before
subprocess, claim-file, synthesis-directory, or dial effects. Required skips still block the
verifier; its existing skip-contract tests remain intact. Verifier edits here are only the
capability import and six decorators; R26/R37 and the other workers' fixes are preserved.

Red evidence: `timeout 20s python3 tests/telegram-761-process-bounds.test.py -v`
initially failed allocation (62,948,264 bytes with the initial 24 MiB producer) and TERM-fork
latency (4.309 s against a 2 s bound). Forcing `owned_processes.available=False` before
loading safety test A08 reproduced its incorrect success expectation: actual exit 2 versus 0.
The final producer is smaller: 16 MiB total, with 16,796,736 bytes measured peak Python
allocation, 4,194,304 retained characters per ASCII stream, exit 0, and truncation reported.
The allocation assertion allows 28 MiB and does not claim an RSS measurement.

Local commands (all synthetic, supported Linux, zero skips):

| Command | Tests passed |
| --- | ---: |
| `timeout 50s python3 tests/telegram-761-runner-safety.test.py -v` | 16 |
| `timeout 55s python3 tests/telegram-761-verify-calls.test.py -v` | 57 |
| `timeout 25s python3 tests/telegram-761-nested-process.test.py -v` | 4 |
| `timeout 20s python3 tests/telegram-761-process-bounds.test.py -v` | 4 |

Final verification repeats these four suites both directly and through real `Context.run`:
`timeout 55s python3 /tmp/761-process-proof.py direct` and
`timeout 55s python3 /tmp/761-process-proof.py context`. The temporary harness uses a scrubbed
environment, 45 s per suite, and rejects nonzero exits, timeouts, truncation, and skips.
Full stderr/results are in `/tmp/761-process-direct-final.jsonl` and
`/tmp/761-process-context-final.jsonl` (81 tests per mode).

Forced-unavailable runs of safety/verifier passed their portable assertions with exactly
six explicit capability skips each (16/57 tests discovered). The dedicated unavailable
regression itself runs, rather than skipping. `git diff --check` passes.

The four focused regressions cover bounded allocation/retention, concurrent stdin delivery
and draining both output streams, a real TERM handler that detaches a child, and timeout
return while an escaped process still holds a pipe. PID checks reject zombies and verify
an unrelated sleeper remains alive. The new suite is registered in the manifest and Bun
wrapper. Full integration/media checks, Bun wrapper execution, mutation controls, staged
review, and remote verification remain with main; ffmpeg is absent locally. No live
acceptance or listening claim is made.
