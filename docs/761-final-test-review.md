# #761 final test review

Only `tests/telegram-761-verify-calls.test.py` and this note are owned by this change; edits remain unstaged.

R26 now exercises the real probe parser and production Telegram mirror with an injected client. It checks the exact `caller`/`me` resolver invocation, independently verified owner, two sends (anchor and transcript), exactly one anchor status edit, and one readback. Unexpected client operations fail; the transport dial boundary is guarded and must remain unused. Arbitrary `--peer`/`--chat` arguments are rejected by argparse for all three probe commands. Existing run-bound idempotency assertions remain.

R37 waits for an active runner SIGTERM handler and the child PID marker before signaling. Its worker has a ten-second readiness deadline and is stopped and joined in `finally`; the subprocess has a twelve-second bound. The test deliberately delays the first context git operation by three seconds and retains strict interruption, descendant-disappearance, remaining-check, and handler-restoration assertions.

Red/green evidence (offline, no ffmpeg):

- Old R37 + first `Context.git` delayed three seconds: exit 130, `KeyboardInterrupt` during `ctx.tested_sha = ctx.git(...)`, before protected suite execution.
- Injected wrong-recipient mirror and repeated-status-edit mutations: each produces one R27 assertion failure; no production files were mutated.
- Hidden child-ready marker: bounded R37 assertion `child-ready handshake failed`; no self-SIGTERM and no surviving signaling thread.
- Focused parser, Telegram probe, and slow-start interruption run: 6 tests, OK (3.446 seconds).
- Healthy deployed dry-run now expects `ready: false`; `missing: ["tts"]` still fails as `tg_dry_run_not_ready`. Strict schema/exit coverage belongs to the parallel contract worker.

Process dependency: R37 still requires production process-tree cleanup. Its strict child-PID-disappearance assertion passes with the current parallel worker changes; no process dependency failure remains observed. No cleanup assertion was weakened. The full 57-test bounded result is recorded below.

Final command: `timeout 120s python3 tests/telegram-761-verify-calls.test.py -v`

```text
Ran 57 tests in 29.943s

OK
```

Exit 0. Full stdout/stderr: `/tmp/761-final-runner-tests-final.log`. Test file: 1,167 lines. No network, real credentials, calls, full Bun suite, commits, pushes, or deployment.
