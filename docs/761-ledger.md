# Issue 761: identified calls and private history

Approved implementation plan (offline worker; no commit, network, live config or calls).

- [x] Inspect current interfaces and run relevant baseline.
- [x] Add failing tests for identity, preparation, private audit, mirrors and entrypoints.
- [x] Implement one call service with injected effects; both frontdoors use the same store.
- [x] Send an exact-recipient transcript before dialing, update its anchor with the outcome.
- [x] Add offline history, safe stdin handoff, installer alias, and usage documentation.
- [x] Attack failure/cancellation/concurrency cases and obtain independent review.

Design: retain the existing MTProto role/session locks and source-idle checks. A private
SQLite journal under `mtproto/calls/` records intent before any network operation and
durable status transitions. A unique caller-supplied idempotency key claims one attempt;
an interrupted attempt is never automatically replayed. Resolve recipients with the calling
account, send plain text into that exact private chat, and fail before dialing unless every
transcript chunk is acknowledged. Never route arbitrary peers into the owner's bot chat.
The anchor is a short call identity/status message; transcript chunks reply to it so updates
cannot truncate the transcript. No audio recordings or inferred listening receipts.

Speech starts with a short Russian introduction: agent, kind, task/project, content.
Absent context is explicitly unknown; ids and titles remain separate fields. Raw audio
gets a synthesized introduction followed by the original file; any supplied transcript is
labeled caller-provided, otherwise its content is explicitly unknown.

Baseline: Python user-account suite: 33 tests, OK (1 dependency skip). Bun user-account
baseline: 17 passed. Six auth integration tests failed before changes because this sandbox
refuses the fixture's loopback `Bun.serve` listener (`EPERM: operation not permitted, listen`).
They were not rerun as live/network tests. The Bun launcher also initially tried a read-only
home cache; subsequent commands set `HOME=/tmp/761-test-home`, retaining its normal lock and
cleanup behavior while keeping test state under `/tmp`. No guardrails/hooks were changed.

Integration dependency: the parallel TTS worker adds `config_dir` and sanitized `tts.json`
metadata to `synthesize`. This worker does not modify TTS implementation or its tests.

## Implementation result

Worktree: `/home/ultra/dev/tg-cli/.worktrees/call-ledger-20261016`.
Branch: `fix/call-ledger-20261016`.
Existing HEAD: `8ab6a11c631dc6a8fb397556db6ca8e398d149e3`.
**No implementation commit was created**: the final execution restrictions explicitly forbid
commits/push/merge/deploy. The integrator should commit these changes with `Refs #761` after
combining the TTS dependency and running integration gates. No live checkout, other worktree,
notification daemon, TTS-owned source/test, home config/credential or shared cache was edited.

The existing `tg` dispatch already calls the shared user-account parser/orchestrator, so no
entrypoint duplication or direct `tg` edit was necessary. New executable `call-cli` imports
those same modules directly. `tg-call` remains the existing Python shim and reaches the same
one-shot service through `cli.call`. `install.sh` installs all three frontdoors into the
same checkout; it performs no new auth/session copying.

SQLite intent commits precede recipient resolution/network. Each acknowledged mirror chunk's
id is persisted; the complete transcript must arrive before TTS/dial. Outcomes are honest:
`audio_stream_ended`, `failed`, `timeout`, `cancelled`; none asserts hearing. Intent/attempting
rows after hard termination require manual reconciliation. Tokens never replay automatically.
A later TTS failure preserves metrics from already completed segments. Journal paths are fixed
under the selected store, never derived from agent/task ids; SQLite binds queries and rejects
unsafe private files/directories and final-file symlinks. History does not initialize a store.

The mirror uses the verified calling account's private recipient chat, not a guessed bot-chat
mapping. Bot topic ids are explicitly refused. Private-chat reply ids may be supplied with
`--reply-to`; this does not infer a bot-topic/reply mapping from a session. Registry context
supplies agent/session labels and stable session ids only, never invented task/project ids.

## Verification evidence

Red-first evidence: the original `call --dry-run` path failed
`test_existing_dry_run_includes_identified_spoken_text_without_writes` with
`AssertionError: 'Привет!' not found in ''`. That same public CLI test now passes.

Final bounded, offline commands and results:

- `timeout 30s python3 tests/telegram-call-service.test.py`: **21 passed**.
- `HOME=/tmp/761-test-home timeout 30s bun test ./tests/user-call-ledger.test.ts`:
  **5 passed**, 27 assertions.
- `HOME=/tmp/761-test-home timeout 30s bun test ./tests/user-account.test.ts`:
  **17 passed**, 112 assertions.
- `HOME=/tmp/761-test-home timeout 30s bun test ./tests/telegram-client.test.ts`:
  **7 adapter tests passed**, 14 assertions (runs the credential-free Python suites).
- `timeout 20s python3 tests/telegram-user-account.test.py`: **33 tests, OK, 1 skipped**
  (pyrofork absent). Same result before and after implementation.
- `timeout 30s python3 tests/telegram-call-lib.test.py`: **7 passed**.
- `timeout 20s python3 tests/telegram-client.test.py`: **14 passed**.
- `git diff --check`: passed.

Counts overlap: the Bun Python adapter invokes the Python test files above; do not add them
as independent cases. No full suite, build/download, external review CLI or live acceptance
was run. No project typecheck/lint script or installed local TypeScript checker was present.

Adversarial cases include unknown/explicit/env identity; ids versus titles/URLs; all call
kinds; raw audio with unknown or caller-provided text; literal shell/HTML text; metadata path
traversal remaining data; secret exception redaction; exact recipient and private reply
context; long emoji transcript chunking with no truncation; partial mirror failure;
no-answer/timeout/cancellation; cancellation during result edit; result-update warning;
later TTS failure retaining completed segment metrics; idempotency after failure; concurrent
journal/history access; symlink refusal; intent-write failure blocking all network; missing
sessions/offline dry-run without runtime/bootstrap/state writes; shared frontdoor/store/stdin;
and legacy native/watcher refusal before transport imports.

Independent read-only offline review: separate `offline_review` agent; two findings addressed:
(1) `parse_mode=None` could select Pyrogram defaults — production now explicitly injects
`ParseMode.DISABLED`; (2) only the first TTS segment was audited — all segments now recorded.
Follow-up verdict: **no unresolved findings**. Reviewer independently reran the Python and
Bun call-ledger tests. The final addition persists each segment immediately so a later
synthesis/concat failure cannot erase earlier metrics; covered by a dedicated regression.

## Remaining integration checks / support boundaries

1. Integrate the parallel TTS worker before real use. Baseline `synthesize` lacks `config_dir`;
   until integrated a real attempt will be journaled as preparation failure and will not ring.
   Confirm its sanitized `tts.json` keys match the service's allowlist (engine, voice,
   language, duration_ms, elapsed_ms, characters, sample_rate, provider, model, fallback_reason).
   Each segment additionally records its index and actual input character count.
2. Production native conversational `start` and legacy `watch-call` fail closed with
   `CONVERSATION_REQUIRES_IDENTIFIED_SERVICE` / `WATCH_CALL_REQUIRES_IDENTIFIED_SERVICE`.
   Their real-time reply streams are not journaled/mirrored by this checkpoint. Native
   fake-backend conversation tests remain supported. A future integration must add the
   intro/mirror before native dialing rather than removing those guards alone.
3. No verified owner-bot/session-topic mapping is implemented. Exact calling-account private
   chat delivery is implemented. Bot topic requests are refused rather than leaking or
   silently changing context.
4. Integrator must verify real pyrofork message send/edit contracts, caller permissions,
   recipient resolution, ffmpeg concatenation, actual TTS voice/metrics and a consented
   end-to-end call. Offline tests do not prove intelligibility, listening or live delivery.
5. Run repository gates in an environment that permits their local fixtures, then commit
   with `Refs #761`. Another integrator owns merging, deployment and live acceptance.

Changed files:

- `AGENTS.md`, `docs/specs/independent-telegram-clients.md`, `docs/761-ledger.md`
- `call-cli`, `install.sh`
- `features/telegram_client/call_identity.py`, `call_journal.py`, `call_mirror.py`,
  `call_service.py`, `call_lib.py`, `cli.py`
- `features/user-account/args.ts`, `cli.ts`, `help.ts`, `messages.ts`, `sidecar.ts`,
  `sidecar-fs.ts`
- `tests/telegram-call-service.test.py`, `tests/user-call-ledger.test.ts`,
  `tests/user-account.test.ts`, `tests/telegram-client.test.ts`

Final completion self-check:

- Did I finish the assigned offline work and account for every requested deliverable? Yes:
  shared service/frontdoors, journal/history, identified speech, exact-recipient pre-call
  mirror, dry-run isolation, tests, independent review and this report are present. Commit,
  external progress files, integration/live checks and deployment are excluded by the final
  execution restrictions. Native conversation/watch support is explicitly gated/documented.
- Are concrete follow-ups recorded? Yes: TTS schema/API integration, native conversation/watch
  integration, verified topic mapping if needed, and consented real transport/voice checks
  are listed above under issue #761 for the integrator.

Final reviewer confirmation after immediate per-segment persistence: **21 Python tests passed;
no unresolved review findings**. Final Bun adapter run: **7 passed**, including the 21-test
call-service suite. Final `git diff --check`: passed.
