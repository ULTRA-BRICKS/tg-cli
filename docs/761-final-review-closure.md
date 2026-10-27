# #761 final formal-review corrections

All four requested corrections are implemented. This worker's changes remain unstaged; this worker did not alter the index, reset, stash, commit, push, deploy, or operate the server. At the final check, the reviewed baseline was HEAD `d429e80` and the index was clean; the baseline commit occurred outside this worker's actions.

Files changed by this worker:

- `scripts/call_acceptance/process.py`: abnormal supervisor death triggers SIGKILL of only its original owned process group. Normal supervisor acknowledgment retains cooperative descendant reaping. Bounded cleanup that cannot be confirmed produces `Outcome.error = "CLEANUP_FAILED"`; timeouts retain `code=None`, `timed_out=True`, and empty output. Cancellation keeps its original exception.
- `scripts/call_acceptance/owned_processes.py`: send SIGCONT after SIGTERM so a stopped supervisor can run its handler and reap descendants.
- `scripts/call_acceptance/deployed.py`: the named pure `requested_peer_matches(payload, expected_peer)` validator checks the requested `@verifycalls` recipient. Offline identity limitations derive from that expected peer. Healthy production plans remain exit 3, `ready=False`, identity unverified.
- `tests/telegram-761-nested-process.test.py`: real children kill/stop their supervisor in direct and nested variants; unrelated sleepers remain alive. Linux-specific cases have capability guards. Portable normal exits 0/7/127 remain covered, while bad interpreters correctly produce supervisor code 127 or unsupervised `SPAWN_FAILED`.
- `tests/telegram-761-probe-contracts.test.py`: use the real `@verifycalls` offline plan and reject missing or wrong peers.
- This closure note. No manifest, CI, package, dependency, or report files changed.

Red evidence, captured before implementation:

- `/tmp/761-closure-process-red.log`: killed-supervisor children survived in both variants; stopped-supervisor variants raised uncaught `TimeoutExpired` after the 4+2 second termination waits.
- `/tmp/761-closure-peer-red.log`: missing peer and `@other` were incorrectly accepted as passing dry runs.
- `/tmp/761-closure-portable-red.log`: unsupervised bad interpreter returned `None` where the existing test incorrectly required 127.

Green verification used only synthetic local processes and isolated fixtures, without ffmpeg, live credentials, network, APIs, or calls:

| Focused suite | Direct tests | Through `Context.run` |
| --- | ---: | ---: |
| process-bounds | 4 passed | 4 passed |
| nested-process | 7 passed | 7 passed |
| runner-safety | 16 passed | 16 passed |
| verify-calls | 57 passed | 57 passed |
| probe-contracts | 10 passed | 10 passed |
| Total | 94 passed | 94 passed |

Each direct command was `python3 tests/telegram-761-<suite>.test.py -v`, with a 65-second subprocess bound under a 100-second wrapper. The second pass ran the same argv through `Context().run(..., 65)` under a 100-second wrapper. All direct exit codes were 0; every context outcome had code 0, no timeout, no truncation, and no error. Logs: `/tmp/761-closure-direct-<suite>.log` and `/tmp/761-closure-context-<suite>.log`, using the suite names above. No tests were skipped on the current Linux host. A separate forced-unavailable capability run skipped the five Linux-specific lifecycle cases and passed both portable contract cases. `git diff --check` passed.

Remaining limits: after a supervisor is killed, the runner can kill its original group but cannot reap an orphan adopted by another process. A group still present at the confirmation deadline therefore yields `CLEANUP_FAILED`; the regression fixture adopts and reaps that orphan and verifies SIGKILL termination. Detached malicious same-uid descendants are outside this correction. No process-table polling or global name-based cleanup was added. Other-platform cleanup behavior is unchanged on the covered portable paths. No full project suite or formal review was run; the main worker owns the mandatory formal review.
