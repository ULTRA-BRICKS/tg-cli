# Call verification CI handoff (#761)

Release-integration scope: branch `test/761-call-integration-complete`, base
`218a7a4`. This worker made no commit, push, merge, deployment, credential read,
provider request, Telegram request or call. Final combined-head CI remains pending.

Changed files owned by this worker:

- `.github/workflows/ci.yml`: retain ffmpeg and existing gates; add Python venv/dev
  packages and a C compiler; install the source lock with pip's resolver and
  `--require-hashes` in a new `RUNNER_TEMP/call-verification.*` venv. Run `pip check`,
  the two deterministic metadata regressions, then the complete hermetic runner
  through that same interpreter. Upload JSON/JUnit using the pinned Forgejo action
  already used by CodeQL, including on failure. Missing reports fail the upload.
- `tests/ci-call-verification.test.ts`: parse YAML and execute the verification
  step with interpreter/media boundary stubs; capture actual argv, check fresh
  paths, shared interpreter, source lock, report paths and failure propagation.
  Also check pinned uploader, OS prerequisites, full Bun step and 30-minute bound.
- `package.json`: bump `1.71.0` to `1.71.1`; preserve the existing `test:calls` and
  `test:calls:deployed` additions from the integration work.
- `CHANGELOG.md`: concise patch entry for lock compatibility and verifier/CI.
- `docs/761-ci-call-verification.md`: this handoff and usage.

## Commands and scope

Default verification, with a hash-installed call runtime selected as `python3`:

```sh
python3 scripts/verify-calls.py --hermetic
```

This runs the runner's current manifest rather than a CI-maintained test inventory.
Fixture integration checks orchestration with controlled effects. Regression suites
exercise runtime contracts with installed native dependencies where required. This
does not establish real provider synthesis, Telegram delivery, ringing, recipient
hearing or two-way conversation. Required missing prerequisites or skipped cases
must not produce a successful hermetic result. CI injects no provider secrets and
requests no live levels. The normal full Bun suite remains in the workflow.

Explicitly **BLOCKED live command** (record only; do not remove denial blocks or run
live checks as a workaround):

```sh
python3 scripts/verify-calls.py --deployed --telegram --tts --call \
  --run-id blocked-761-20261027 \
  --block deployed:outside-worker-scope \
  --block telegram:outside-worker-scope \
  --block tts:prior-tool-denial \
  --block call:prior-tool-denial
```

Blocked is not passed. Production conversational support and recipient hearing
remain unverified. This worker did not execute the live command.

## Red and green evidence

Before workflow changes:

```sh
timeout 30 bun test tests/ci-call-verification.test.ts
```

Exit 1: **0 passed, 3 failed**. Expected failures named the missing clean-runtime
step and missing Python prerequisites. The host Bun wrapper also printed a
read-only cache-path warning; the tests themselves ran and failed as expected.

After changes (use a writable temporary HOME for the host wrapper's test cache):

```sh
HOME=/tmp/761-ci-test-home TMPDIR=/tmp timeout 30 bun test \
  tests/ci-call-verification.test.ts tests/ci-workflows.test.ts
```

Exit 0: **10 passed, 0 failed, 52 assertions**. The focused contract covers
successful execution, failed install stopping before the runner, and failed runner
propagating its nonzero exit without retry or fallback evidence. Interpreter
stubs mean these tests are workflow execution evidence, not package installation
or runner-suite evidence. No full local suite was run.

Separately, the orchestrator reports a successful clean server hash-locked install
of all 20 packages on Python 3.13.16, `uv pip check`, all three lock regressions
(including resolver reinstall), and unskipped native contracts: duplex 5,
providers 7, user-account 33. Those are prior execution results supplied to this
worker; this worker did not inspect user configuration or the logs. They do not
prove this CI workflow has executed.

## Remaining main verification

Run final combined-head CI after the hardening worker finishes the runner and
tests. Require a successful clean pip hash install, exactly two offline lock
regressions with no opt-in skip, a passing complete hermetic runner with its JSON
and JUnit artifacts, the full Bun suite, and existing security gates. Check the
artifacts for required missing/skipped/blocked cases. No green final-head CI or
live voice result is claimed here. Keep the existing live-call denial in force.
