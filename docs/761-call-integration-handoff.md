> Historical implementation log from the preserved branch. Its versions, execution
> status and pending-work statements describe earlier snapshots. Current verification
> is recorded in `docs/761-final-execution.md` and the private final evidence directory.

# Issue #761 implementation handoff

Independent read-only review passed after the audit follow-up below. Ready for main’s
server verification; acceptance is **not fully green**. The orchestrator reported the
pre-audit 33-case integration snapshot passed on server 65.21.40.51 with ffmpeg in
16.236 seconds. The final suite has 35 cases and still needs that server run.
Branch: `test/761-call-integration-complete`.
Base: `218a7a45b1b265fc56094ea92ce69e0a6e58eb49` (base package **1.71.0**).
The integration worker did not alter the declared version. Concurrent CI/release work
now sets **1.71.1** and repairs the dependency lock; current audit reports capture 1.71.1.
All changes are uncommitted in this isolated worktree. The old draft was read/copied,
never edited. This integration worker changed no production module, installer, daemon
setting, hook or security policy. Concurrent runtime-lock/CI work is identified below.
No SSH, live credential reads, external API requests, Telegram sends or calls occurred.

## Changed files

- `scripts/verify-calls.py` and `scripts/call_acceptance/*.py`: reused runner, split modules;
  hermetic default, separate deployed and live levels, strict prerequisites and reports.
- `tests/telegram-761-call-integration.test.py`: reused 33-case suite; real Bun entrypoints,
  Python CLI/shared service, SQLite, mirror, speech/metrics and real ffmpeg concatenation.
- `tests/telegram-761-verify-calls.test.py`: 57 runner regressions; reusable synthetic host
  extracted to `tests/support/call_runner_world.py` (largest new module <1200 lines).
- `tests/support/{call_fixture_sidecar,call_lab,call_mutation_controls,wav_tools}.py`:
  synthetic accounts/audio and external-boundary fixtures; no actual credentials copied.
- `tests/telegram-761-calls.test.ts`: normal Bun discovery for the two new Python suites;
  no manifest recursion and no repeat of existing regression wrappers.
- `package.json`: this worker added `test:calls` and `test:calls:deployed`; the concurrent
  release worker subsequently bumped the version to 1.71.1 without dropping those scripts.
- `.github/workflows/ci.yml`: add ffmpeg to the existing media dependency installation.
- `tests/call-integration.md`: requirement-to-test traceability and executed IDs/statuses.
- `docs/superpowers/plans/2026-10-27-call-integration-tests.md`: approved scope/checklist.
- `docs/evidence/761-local-{integration,blocked-live}.{json,xml}`: actual incomplete local
  runner reports, production/verification digests, source SHA, version and explicit blocks.

## Repairs after failing checks

These repairs are in verification code only. Red cases were executed before fixes:

- Required regression skips incorrectly returned exit 0. They now block; Bun skip/todo
  counts and truncated output also cannot make acceptance green.
- Missing built sidecar runtime allowed online CLI startup. It now fails before startup,
  avoiding implicit dependency bootstrap. Missing integration tools block before suite spawn.
- A SIGTERM-ignoring descendant could hold a pipe after its leader exited and hang timeout
  cleanup. The runner now kills the remaining owned process group before draining pipes.
- Different frontdoor histories and malformed daemon-code status could pass deployed checks.
  They now fail with bounded diagnostics. No complete history is placed in reports.
- Invalid report directories were detected after checks ran. They now fail during preflight.
- JUnit omitted source digest/version metadata; it now includes tested/installed metadata.
  Production digest includes the locked requirements; a separate digest identifies the
  verification code, including uncommitted tests and fixtures.
- Mutation controls now require a passing unmodified baseline and media prerequisites;
  environmental errors/timeouts cannot be reported as killed mutants.

## Initial local results (preserved; superseded where the audit follow-up changes counts)

Commands run from this worktree:

| Command | Result |
| --- | --- |
| `timeout 40s python3 tests/telegram-761-call-integration.test.py -v` (copied baseline) | 33 ran: 27 pass, 6 fail; local ffmpeg missing |
| `timeout 35s python3 tests/telegram-761-verify-calls.test.py` (final) | 57 pass, 0 skipped; 15.740 s |
| selected integration command below (final) | 27 pass; 13.103 s |
| `timeout 20s python3 tests/telegram-tts.test.py` | 20 pass; includes PR #776 streaming headers |
| `timeout 20s python3 tests/telegram-call-service.test.py` | 24 pass; includes terminal database failure |
| `timeout 25s bun test ./tests/user-call-ledger.test.ts ./tests/user-call-audit-warning.test.ts ./tests/user-call-offline-runtime.test.ts` | 18 pass, 67 assertions |
| `timeout 30s bun test ./tests/telegram-761-calls.test.ts -t telegram-761-verify-calls.test.py` | 1 wrapper pass (57 Python cases); integration wrapper explicitly filtered |
| `python3 scripts/verify-calls.py --hermetic --suite integration --report-json docs/evidence/761-local-integration.json --report-junit docs/evidence/761-local-integration.xml` | exit 2; ffmpeg prerequisite blocked; 0 pass / 1 blocked |
| blocked plan command below, with local evidence report paths | exit 2; 0 pass / 12 blocked; no deployed/live effects |
| `timeout 10s python3 tests/support/call_mutation_controls.py wrong-chat-accepted` | exit 2, missing ffmpeg; no mutation run |
| `ruff check --no-cache scripts/verify-calls.py scripts/call_acceptance tests/support tests/telegram-761-call-integration.test.py tests/telegram-761-verify-calls.test.py` | pass, no findings |
| `git diff --check` | pass |

The Bun shell wrapper emitted an existing read-only-cache `mktemp` warning before Bun
started; the tests themselves passed. No lock or guard was bypassed. Counts overlap;
the wrapper's 57 Python cases are the same runner suite, not additional coverage.

Exact selected integration command (six media-dependent cases remain required):

```sh
timeout 35s python3 tests/telegram-761-call-integration.test.py \
  Mirror IdentityAndHistory Hostile Outcomes OpenInheritedStdin DetectorsCatchRegressions \
  DryRunAndModes.test_i16_dry_run_has_zero_network_tts_auth_reads_and_call_state_writes \
  DryRunAndModes.test_i18_live_two_way_conversation_is_rejected_before_any_provider_or_connection_effect \
  SpeechProvider.test_i13_missing_or_unconfirmed_provider_never_falls_back_to_host_speech_or_dials \
  SpeechProvider.test_i15_completed_segment_metrics_survive_a_later_segment_failure_and_nothing_dials \
  SuccessfulOneShot.test_i01_quick_intro_exact_mirror_effect_order_and_same_anchor_edit \
  SuccessfulOneShot.test_i01b_human_frontdoor_output_never_claims_listening \
  SuccessfulOneShot.test_i02c_the_prefix_detector_fails_when_the_order_is_wrong
```

## Exact commands for the orchestrator

On server **65.21.40.51**, in a copy of this branch/worktree with the same source bytes,
run the complete default manifest. No live account/config is needed:

```sh
python3 scripts/verify-calls.py \
  --report-json /tmp/761-server-NEW.json --report-junit /tmp/761-server-NEW.xml
# Equivalent default suite selection:
bun run test:calls
# Normal discovery of both added suites:
bun test ./tests/telegram-761-calls.test.ts
# Required controls already included in the default manifest; standalone diagnosis:
python3 tests/support/call_mutation_controls.py
```

Use new report paths on every run; existing paths are deliberately refused. Exit codes:
0 all requested checks passed; 1 failed; 2 blocked; 3 not run/interrupted; 64 invalid usage.
The default manifest contains one 35-case integration/controls suite, 20 Python regression suites, six Bun
regression suites and the eight-mutation control batch. It never invokes its own complete manifest from a nested test.

Read-only deployed checks are separate, **not performed by this worker**:

```sh
python3 scripts/verify-calls.py --deployed \
  --report-json /tmp/761-deployed-NEW.json --report-junit /tmp/761-deployed-NEW.xml
```

They compare installed aliases/code against the tested checkout, so a pre-merge installed
main may differ and must fail honestly. Add `--hermetic --deployed` to request both levels.
Optional voice pins come from private runtime configuration via `--expect-voice-id` and
`--expect-model`; no personal voice ID is committed. No deployed check authenticates online.

Safely blocked live example (the corresponding plan was actually run locally):

```sh
python3 scripts/verify-calls.py --deployed --telegram --tts --call --two-way \
  --run-id blocked-761-20261027 \
  --block deployed:local-scope --block telegram:not-authorized --block tts:tool-denied \
  --report-json /tmp/761-blocked-NEW.json --report-junit /tmp/761-blocked-NEW.xml
```

Do not remove the TTS tool-denial block or work around it through another process or
service. Calls depend on TTS and remain blocked. Unsupported two-way speech is explicitly
blocked as `CONVERSATION_REQUIRES_IDENTIFIED_SERVICE`, never represented as listening.

## Dependencies and remaining verification

Server: Bun, Python >=3.11, git and real ffmpeg on PATH. The default Python interpreter
should have the existing sidecar test dependencies (`pyrofork`/`pyrogram`, `py-tgcalls`/
`pytgcalls`, native `ntgcalls`, `aiohttp`) to exercise installed-library/loopback regressions.
Use an already provisioned interpreter: `path/to/venv/bin/python scripts/verify-calls.py`.
The runner never installs them; any dependency skip blocks acceptance. Linux is needed
for the descendant-reaping regressions. No real Telegram/Fish credentials are needed.

Pending under #761: the final full manifest and required mutation controls on the server.
The six concatenation cases passed in the orchestrator’s pre-audit server snapshot;
no concatenation fake or skip was added. Independent read-only review has passed. Deployed alias/daemon/autostart/profile
checks remain unperformed. Live Telegram/Fish, sound quality, intelligibility, voice
identity, latency and independent word/character error evaluation remain unperformed.
Synthetic tones prove signal/order/measurement behavior, never naturalness or listening.
WER, CER and naturalness remain null where unmeasured; stream completion is not a receipt.

Completion self-check: implementation, focused execution, traceability, reports and
server instructions are present. Full server/deployed/live acceptance is not claimed.
The concrete remaining action is the orchestrator's server run and independent review.

## Final audit follow-up (latest disposition)

| Original audit finding | Disposition and evidence |
| --- | --- |
| P1 wrong positive self recipient | Reproduced `9999` succeeding. `verified_owner` now connects the personal session and verifies its ID against the saved expected ID. Both mirror and call probes compare resolution against that independently verified owner. R28 and A01 reject the wrong peer before mirror/audio/dial. |
| P1 detached preparation worker survives timeout/cancel | Reproduced an outer timeout (exit 124) when a separate-session child retained pipes. Linux pidfd ownership checks now enumerate/freeze only the owned tree. A02/A03 exercise real `start_new_session` and real `Effects.synthesize` with a sleeping fake provider, preserving unrelated sleepers. |
| Reviewer follow-up: leader exits first | Independently reproduced a 0.2-second timeout lasting 2.03 seconds. A disposable per-command subreaper adopts detached descendants before the command starts; normal exit and timeout both clean owned children. A16 covers children with open and closed pipes. Reviewer’s same reproduction now exits 0 in 0.06 seconds. No agent/daemon/global subreaper state is changed. |
| P2 required skips green | Already fixed before this audit: R04B/R04D block Python/Bun skips and truncated output; JUnit records incomplete checks as errors. |
| P2 PR776 missing | Already preserved by the fresh 1.71.0 base. The existing 20-case TTS suite passed again; it executes production HTTP normalization with fake HTTPS responses for both sentinel pairs and rejects finite truncated/invalid WAVs. No duplicate streaming test or production change was necessary. |
| P2 nonzero commands accepted | Reproduced dry-run exits 1/3 with good JSON and nonzero probe success JSON. A04–A06 now require successful exit plus appropriate dry-run schema/readiness. Status exit rejection was already fixed and is asserted again. |
| P2 call-run ID reuse repeats earlier effects | Reproduced both invocations starting all fake live stages. A08–A10 now prove a durable exclusive `call.run_claim` before ANY call-run live stage, zero replay effects, and no claim/live stages for blocked TTS or missing runtime. A13 proves one concurrent winner/private state; A14 proves interruption permanently consumes the ID. |
| P2 required scenario can disappear | Reproduced helper-only integration passing. A07/A11 require the fixed scenario inventory; a discovery assertion also protects ordinary Bun/Python execution. Eight named mutation controls, including scenario deletion, are required by the default manifest. A12 refuses an incomplete mutation summary. |
| Existing journal read-only gap | New I20 creates a real fixture journal and checks logical digest plus mode/size/mtime tree before/after list/show through both primary frontdoors. Passed locally and independently. Only hashes/counts are asserted; no user transcripts are accessed. |

A IDs are **runner safety regressions**, not end-to-end live acceptance. Their complete
file is `tests/telegram-761-runner-safety.test.py` (15 cases). R22B was updated to the
requested stricter transaction behavior: blocked TTS allows independent read-only deployed
checks but blocks the entire call-run live sequence and creates no claim. No old test was
removed. The original draft worktree and all earlier report artifacts remain unchanged.

Additional files: `scripts/call_acceptance/{owned_processes,run_claim,scenario_inventory}.py`,
`tests/telegram-761-runner-safety.test.py`, and `docs/761-call-integration-review.md`.
The largest source/test module remains below 1200 lines.

Final focused commands/results (not a repository-wide or full-manifest run):

- `timeout 40s python3 tests/telegram-761-verify-calls.test.py`: **57 passed**, 31.554 s.
- `timeout 20s python3 tests/telegram-761-runner-safety.test.py`: **15 passed**, 6.099 s.
- The selected integration command above with `CoverageInventory` added:
  **29 passed**, 16.671 s, including I20 and the normal-discovery inventory assertion.
- `timeout 10s python3 tests/telegram-tts.test.py`: **20 passed**, 0.150 s.
- After final report-label metadata adjustment, R04 alone passed again (0.380 s),
  asserting `I01 = integration` and `I18 = regression` explicitly in report evidence.
- Ruff and `git diff --check` pass. `verify-calls.py --help` prints the permanent claim,
  required mutation group, separate deployed/live levels and meaningful exit codes.

Fresh **incomplete** reports, generated by the actual runner after the fixes:

```sh
python3 scripts/verify-calls.py --hermetic --suite integration --suite regression-mutations \
  --report-json docs/evidence/761-audit-local-offline.json \
  --report-junit docs/evidence/761-audit-local-offline.xml
# exit 2: 0 pass / 2 blocked (ffmpeg absent); no tests silently skipped.

python3 scripts/verify-calls.py --deployed --telegram --tts --call --two-way \
  --run-id audit-blocked-761-20261027 \
  --block deployed:local-scope --block telegram:not-authorized --block tts:tool-denied \
  --report-json docs/evidence/761-audit-blocked-live.json \
  --report-junit docs/evidence/761-audit-blocked-live.xml
# exit 2: 0 pass / 13 blocked; no deployed/live effects and no run claim created.
```

These new report paths are create-only and already exist; use new paths to reproduce.
The `761-local-*` reports are the preserved earlier snapshot. The `761-audit-*` reports
identify final source and verification digests. No report claims a real provider or call
passed. Production native two-way remains unsupported/blocked; TTS tool denial is retained.

Read-only independent peer review is recorded in `docs/761-call-integration-review.md`.
The worker did not run the formal staged commit review or bypass any gate; no commit is
requested here. Main still owns all full integration/mutation/repository and server runs.
Linux pidfds and subreaper support are required for live acceptance; unsupported platforms
block live stages. The expert Python `tg-call call` entrypoint remains an explicit optional
end-to-end gap; both required primary frontdoors have full fixture coverage.

Completion self-check: all material audit findings have fixes or a documented already-fixed
regression, focused red/green evidence, and independent review. The remaining concrete work
is main’s final server verification; no additional feature scope is deferred in this worker.

## Concurrent work preserved at final handoff

Final status also contains changes authored by the separate runtime-lock and CI/release
workers: `requirements-call.txt`, `CHANGELOG.md`, `tests/call-runtime-lock.test.py`,
`tests/ci-call-verification.test.ts`, `docs/761-call-runtime-lock.md`,
`docs/761-ci-call-verification.md`, and further CI/package changes. This worker left
those edits intact and did not independently test their network/install operations.
Their source is included where applicable in current code/verification report digests.
The independent safety review above is scoped to the integration/runner hardening;
main owns review and verification of the combined head, including these other changes.

## Final portability correction: private Git (server evidence supplied by main)

The earlier server snapshot passed all 33 integration scenarios and seven mutations;
its full verifier then failed 12 runner cases because fixture PATH hid Git installed at
`/home/ultra/.local/mamba/envs/tools/bin/git` (red log:
`/home/ultra/.cache/call-integration-20261027/runner-exploratory-remote.log`).
The fixture now exposes only the resolved Git executable through its private bin.
Extended R16 proves Git resolves/executes there even with PATH restricted to that bin,
and removal of a fake alias cannot fall through to aliases visible on parent PATH.
SHA and installed-version validation remain strict. R16 failed before the fix and
passed afterward (1 case, 0.418 s). Post-fix scoped execution:
`timeout 50s python3 tests/telegram-761-verify-calls.test.py` — 57 passed, 27.571 s;
`timeout 20s python3 tests/telegram-761-runner-safety.test.py` — 15 passed, 5.702 s.
Focused Ruff and `git diff --check` passed. No other tests or server commands were run.

Main also reports a successful clean server install of all 20 locked packages,
`uv pip check`, three lock tests, and unskipped native duplex 5/provider 7/user-account
33 tests. Earlier full-main baseline failures (31 cases) involved missing lsof, Chrome
and `/usr/bin/git`; they are not new-call acceptance evidence. Final combined-head
35 integration cases/eight mutations/full verification and formal review remain main’s
work. CI, dependency lock, version 1.71.1 and existing reports were left untouched.
