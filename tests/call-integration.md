# Call verification traceability — issue #761

`python3 scripts/verify-calls.py` runs one integration/controls suite, the labeled regression suites and all eight required
mutation controls in the manifest in `scripts/call_acceptance/manifest.py`. `bun run test:calls` is equivalent.
Normal `bun test` discovers the new Python integration and runner suites through
`telegram-761-calls.test.ts`; that wrapper never invokes the verification manifest.

Integration path: real `tg call` / `call-cli` → Python CLI → shared identified service,
SQLite journal, mirror formatting, speech segmentation, Fish response validation,
metrics and real ffmpeg concatenation. The fixture replaces Telegram client/dial and
the Fish HTTPS child only. Its synthesis wrapper bypasses worker dispatch; worker
subprocess lifecycle is covered separately by preparation/process regressions. It wraps the production synthesizer to keep those external
boundary replacements in the fixture process. No service, journal or metrics stub is
used. Synthetic sessions/voice profiles exist only in temporary directories. External
network attempts in the Python fixture are refused by an audit hook.

## Requirements and evidence IDs

I IDs are scenarios in `telegram-761-call-integration.test.py`. Most exercise the
frontdoor through the shared service. I02C is a detector control; I18 is a direct
native-boundary regression; I19/I19B/I19C are subprocess infrastructure checks.
Their location in this file does not make them full call integrations.
R IDs are runner regression scenarios in `telegram-761-verify-calls.test.py`.
Other rows name existing regression suites in the same one-command manifest.
Executed results and environment limitations are recorded in
[`../docs/761-call-integration-handoff.md`](../docs/761-call-integration-handoff.md).
A mapping is coverage intent, not a claim of a passing execution.

| Requirement | Test IDs / existing regression | Type |
| --- | --- | --- |
| Both frontdoors; same canonical private session store and verified identities | I05, I05C, I06, I10, I10B | integration |
| Quick introduction, kind connectors, honest missing context, IDs/titles/URLs separate | I01, I05, I05B | integration |
| Explicit flags over environment over registry; task and session titles never IDs | user-call-ledger: explicit flags override env and registry; environment agent wins registry label | regression |
| Exact private peer mirror acknowledged before synthesis/dial; same anchor edited | I01, I08, I09, I10 | integration |
| Long text and astral UTF-16 limits; literal source/spoken transcripts | I03, I04, I07 | integration |
| Raw audio honest unknown/unverified transcript; real intro-first concatenation | I02, I02B, I02C | integration |
| Persistent SQLite rows, transitions, timestamps, all history filters | I05, I06, I06B; telegram-call-journal | integration + regression |
| Permanent idempotency claim, one attempt, no failed/interrupted replay | I11, I12; telegram-761-watch | integration + regression |
| Timeout/failure/cancel and temporary-file cleanup | I11, I15, I19C | integration |
| Owned child/descendant cleanup and cancellation during spawn | telegram-call-preparation: OwnedProcessTests | regression |
| Observed result differs truthfully from saved result on terminal DB failure | telegram-call-service: terminal persistence / mirror cancellation tests | regression |
| Secret redaction, literal hostile input, speech/context on stdin only | I07, I07B, I13; R11, R11B | integration + regression |
| Dry-run/history/help no auth contents, synthesis, bootstrap or call state | I06B, I16, I19, I19D; user-account help; user-call-offline-runtime; R13 | integration + regression |
| Canonical neural voice, pinned model/voice, no implicit host speech fallback | I13, I14; telegram-tts; R21, R31 | integration + regression |
| Valid/invalid WAV, Fish sentinel streaming headers preserve PCM (#776) | telegram-tts: streaming_sizes, all_ones, streaming_header_does_not_weaken_audio_validation | regression |
| Per-segment actual signal metrics, duration, real time factor; unknown WER/CER/naturalness null | I14, I15; telegram-tts-metrics; telegram-761-tts-integration | integration + regression |
| Private file modes | I17; R08, R09, R20 | integration + regression |
| Unsupported native two-way refuses effects | I18; R23 | boundary + runner regression |
| Fail-closed prerequisites, no fallback/retry; blocked TTS blocks call | R22, R22B, R22C, R24, R25, R25B | runner regression |
| JSON/JUnit, tested/installed SHA/version/digest, exit codes, no overwrite | R01, R08–R12, R14–R16, R39 | runner regression |
| Cancellation, process-group cleanup, default discovery without recursive suites | I19–I19D; R03, R06, R37, R40 | integration + runner regression |
| Installed aliases, daemon code, autostart, paths, dry-run/history, voice | R14–R21 exercise read-only deployed checks with fake installed tools | runner regression; real deployed not run |
| Live Telegram/Fish/call acceptance | R24–R36 validate gated probe contracts using fakes | runner regression; live not run |

## Boundaries

No offline evidence proves voice identity, intelligibility, naturalness, listening or
recipient replies. Two-way speech is unsupported and requested acceptance stays blocked.
TTS tool denial must be retained with `--block tts:tool-denied`; no subprocess or service
alternative is authorization to perform synthesis. `--deployed` is separate, read-only,
and reads session metadata only; it may read nonsecret voice configuration and history,
but reports only bounded summaries. The two history snapshots must agree; a concurrent
call changing the latest row produces `frontdoor_histories_differ`, never a false pass.
No full call history or credentials enter reports. Reports include a production-code
digest and a separate verification-code digest for uncommitted runner/test/fixture bytes.

Any skipped required suite case must make verification incomplete. A selected partial
`--suite` run describes only that selection; only the default manifest is complete call
verification. Heavy default/server runs are delegated to the orchestrator.

## Executed local scenario status (2026-10-27)

- Passed: I01, I01B, I02C, I05, I05B, I05C, I06, I06B, I07, I07B,
  I08, I09, I10, I10B, I11, I12, I13, I15, I16, I18, I19, I19B, I19C, I19D,
  plus the three detector helper cases (27 selected cases total).
- I02, I02B, I03, I04, I14, I17 failed in the initial local 33-case baseline
  because ffmpeg is absent. The orchestrator subsequently reported all 33 pre-audit
  cases passed on server 65.21.40.51 with ffmpeg in 16.236 s. Final 35-case server
  execution remains required after I20 and the discovery inventory assertion were added. No concatenation fake or required skip was introduced.
- R01–R40, including lettered variants, passed: 57 runner regression cases.
- Existing TTS regression: 20 passed, including valid/invalid/streaming WAV (#776).
  Existing shared-service regression: 24 passed, including observed/saved DB failure.
  Bun ledger/audit/runtime regressions: 18 passed (see exact commands in handoff).
- The actual selected integration runner exits 2 with `prerequisite_missing` and
  JUnit error count 1. The safely blocked live/deployed plan exits 2 with 12 blocked
  checks and zero passes. These are incomplete reports, not live acceptance evidence.

## Audit follow-up traceability (final)

| Safety/evidence requirement | Executed check IDs | Classification |
| --- | --- | --- |
| Independently verify personal owner; refuse unrelated positive 9999 before writes | R28; A01 | runner regression, real service path with external fakes |
| Timeout/cancel separate-session preparation workers; preserve unrelated processes | A02, A03 | process/preparation regression with real subprocesses and fake provider worker |
| Exited leader: adopted descendants with open or closed pipes cannot survive | A16 | process regression; independently reproduced and reviewed |
| Exact nonzero-exit rejection plus dry-run schema/readiness | A04, A05, A06 | runner regression |
| Claim before ANY call-run live stage; permanent ID across replay/interruption | A08, A09, A10, A13, A14 | runner orchestration + real private filesystem regression; live effects are fakes |
| Fixed approved scenario names; missing one or helper-only cannot pass | A07, A11; CoverageInventory; R04 | inventory/discovery regression |
| Every named mutation required, no fake control count | A12; default `regression-mutations` manifest group | parser regression executed; real mutation batch server-only pending |
| Existing journal logical state and file metadata unchanged by list/show | I20 | true primary-frontdoor integration |
| Current Fish streaming normalization through real HTTP processing | existing `telegram-tts` FishTests | 20-case regression suite passed; fake HTTP only |

Final local focused execution: 57 R cases passed; 15 A cases passed; 29 selected
integration/control cases passed; 20 TTS cases passed. The full integration/controls
file now has 35 cases, of which 31 have required I IDs. I02C, I18, I19, I19B and I19C
are explicitly labeled regression in JSON scenario evidence; other I scenarios are
integration. Four helper/discovery controls have no I ID. These counts overlap and
are not a live acceptance total.

The fixed inventory lives in `scripts/call_acceptance/scenario_inventory.py`, independent
of discovered tests. The default manifest requires all eight mutation names and a passing
unmodified baseline before mutation results count. Deleting a required scenario is one
of those mutations. Mutation runs call only `--hermetic --suite integration`, preventing
recursive default-manifest execution. Missing ffmpeg blocks both integration and mutation
checks before spawning them. The batch is not run on this workstation.

With `--call`, all requested earlier offline/deployed checks must pass before the private,
exclusive permanent `CONFIG/acceptance-runs/<run-id-sha256>.json` claim. The claim precedes
session-online, mirror-test and fresh-TTS effects, not merely dialing. Any explicitly blocked
call prerequisite blocks that entire live sequence before claim creation. Failed/interrupted
IDs are consumed permanently. `--tts` without `--call` remains a separate explicitly requested
stage, subject to the existing tool-denial block; it is not an authorized workaround.

Linux pidfds and the disposable child subreaper keep detached preparation processes owned;
unsupported hosts block live acceptance. No global daemon/agent subreaper setting changes.
The expert `tg-call call` end-to-end fixture is not added; it is optional in this request and
remains a documented gap. Both primary required frontdoors remain exercised.

Independent final read-only review found no remaining material blocker after reproducing
and checking the exited-leader repair. See the review and exact red/green commands in the
handoff. Final full-manifest/server and all real deployed/provider/call acceptance remain
outside this worker’s execution; the TTS tool-denial and unsupported two-way blocks remain.

## Current-main audit corrections (2026-10-27)

The deployed status probe invokes the supported `tg-ctl status --dry-run` surface.
A real current-source status subprocess with synthetic bot configuration must preserve
configuration bytes, modification times, and the absence of schema metadata. The
status parser still rejects unknown/stale daemon code and nonzero exits.

Mutation acceptance requires an unmodified passing baseline plus all eight named
controls. Each control must produce its designated assertion failure (or the required
scenario inventory failure for deletion), with no scenario errors. A generic failing
integration, missing record, duplicate record, or aggregate success line is insufficient.
JSON records expected and observed scenario IDs, and JSON/JUnit expose nine individual
checks: baseline and each mutation. Private traceback contents never enter those reports.

The file inventory remains 35 cases: 31 required I scenarios, of which 26 are classified
integration and five regression, plus four helper/discovery controls. The manifest has
20 Python regression suites and six Bun regression suites. Synthetic speech exercises
production WAV validation and metrics; it establishes neither real provider playback
nor recipient hearing. Live synthesis remains blocked by `tts:tool-denied`.
