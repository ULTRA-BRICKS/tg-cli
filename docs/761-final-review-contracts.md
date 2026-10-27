# #761 final-review probe contracts

The deployed frontdoor check accepts identical production offline plans with exit 3,
`dry_run: true`, `ready: false`, private session metadata present, configured neural
voice, and only the exact expected unverified identity/origin reasons. For `me`, the
recipient identity reason is required too; the runner's `@verifycalls` probe has only
session identity and source origin reasons. It compares both frontdoors' exit codes
and entire payloads. Unexpected reasons, missing dependencies/session/voice, incorrect
boolean/schema fields, readiness/exit disagreement and unexpected exits remain failures.
The result detail is `identical_offline_only_identity_unverified_not_ready_to_ring`.
No offline pass authorizes dialing. The existing `--call` dependencies still require
independent live session identity and owner mirror proofs before the call probe.

Probe results are parsed with a 64 KiB input bound and non-finite/deep JSON rejection
before exit classification. Every nonzero remains `PROBE_EXIT_NONZERO`, even with
`ok: true`. A small failure sanitizer keeps only a known fixed reason and at most
eight unique positive integer message ids with exact `partial: true`. Unknown error
strings, extra root fields, malformed payloads and invalid ids cannot enter reports.
Zero-exit `ok: false` payloads are sanitized and remain failures. A partial mirror
failure retains its ids and partial warning in the existing report path, without
logging exception bodies, stdout noise, stderr or credentials.

## Fixture handoff to the runner-test owner

`tests/support/call_runner_world.py` now builds `DRY_RUN` with the real
`telegram_client.cli.call_plan`, a temporary `CallLab`, private session metadata
and configured Fish voice. Only dependency discovery is faked. `AuthStore.load` and
credential resolution are patched to raise if called. Its synthetic frontdoors'
dry-run branch now exits 3 after printing that fixture. No World methods or other
helpers changed. This one branch is part of the DRY_RUN fixture contract.

Adapt `Deployed.test_r14_deployed_checks_the_installed_binaries_and_records_both_hashes_distinctly`
in `tests/telegram-761-verify-calls.test.py`: expect `ready=False` and exit 3 instead
of the old hardcoded `True`. That file belongs to the other worker and was not edited
by this worker. During the bounded deployed-class run, this was the sole failure;
the runner itself and all deployed checks passed for the healthy synthetic host.

## Red/green evidence

Initial command:

```text
timeout 45s env PYTHONDONTWRITEBYTECODE=1 python3 tests/telegram-761-probe-contracts.test.py
Ran 7 tests in 0.026s
FAILED (failures=4)
```

The four assertions reproduced rejection of a real healthy offline plan, inability
to compare frontdoors after that rejection, loss of partial message id 501 on nonzero,
and unsanitized zero-exit failure error text. No implementation changed before this run.

A subsequent adversarial assertion exposed `ready=True` plus unverified reasons at
exit 0 being accepted. Before the corrective condition:

```text
Ran 9 tests in 0.530s
FAILED (failures=1)
test_ready_true_cannot_hide_unverified_reasons: 'pass' != 'fail'
```

Final focused command (includes a real acceptance-runner execution against the
synthetic installed host, not an injected green check):

```text
timeout 45s env PYTHONDONTWRITEBYTECODE=1 python3 tests/telegram-761-probe-contracts.test.py
Ran 9 tests in 0.502s
OK
```

Related bounded checks:

```text
timeout 45s env PYTHONDONTWRITEBYTECODE=1 python3 tests/telegram-761-verify-calls.test.py Validators TelegramProbe CallProbe LiveGates
Ran 21 tests in 4.581s
OK

timeout 60s env PYTHONDONTWRITEBYTECODE=1 python3 tests/telegram-761-verify-calls.test.py Deployed
Ran 12 tests in 14.271s
FAILED (failures=1)
```

The deployed failure is the single owner-held assertion described above.

Bun registration check:

```text
timeout 45s bun test tests/telegram-761-calls.test.ts --test-name-pattern telegram-761-probe-contracts
1 pass
3 filtered out
0 fail
2 expect() calls
```

The host Bun wrapper also printed a read-only cache `mktemp` warning before executing
Bun; the selected test still ran and exited 0. No workaround or permissions change
was attempted.

## Files changed by this worker

```text
scripts/call_acceptance/deployed.py
scripts/call_acceptance/probes_runner.py
scripts/call_acceptance/manifest.py
tests/support/call_runner_world.py (DRY_RUN fixture only)
tests/telegram-761-probe-contracts.test.py (new, 146 lines)
tests/telegram-761-calls.test.ts (new suite registration only)
docs/761-final-review-contracts.md (this report)
```

All effects were temporary or mocked. No real authentication, network, synthesis,
calls, full local suite, commits, push or deploy occurred. Prior staged changes were
preserved; this worker's edits remain unstaged. Source README usage still applies.
