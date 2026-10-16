# Issue 761 integration

Scope: this isolated `call-complete-20261016` worktree. No network, live calls,
messages, credential reads, dependency installation, commits, push, merge or deployment.
The existing issue #761 is the durable work item. Worker handoffs are
[`761-ledger.md`](761-ledger.md) and [`761-tts.md`](761-tts.md); this document
supersedes their integration-gap lists where the final integration closes a gap.

## Implemented behavior

- `tg call`, the installed Bun `call-cli`, Python `tg-call call`, and claimed
  `watch-call` events use the shared identified service and existing MTProto store.
  The root installer installs the Bun alias; the Python wheel packages the shared
  service, not a second Bun command or credential store.
- Speech begins `Привет! 3d-house. Проблема с Print Ops. …`; report/question use
  `по`. Unknown agent/task remain explicit; absent project boilerplate is omitted.
  IDs, titles, URLs and session references remain separate in history. Explicit
  flags override environment/registry context; registry labels never become task IDs.
- A readable status anchor includes time, agent/kind, task, caller and supplied
  references. Literal transcript replies must be acknowledged in the exact resolved
  recipient's private chat before dialing. Final status edits the same anchor;
  failed edits surface warnings. No arbitrary-peer transcript goes to the owner bot.
  Bot topic mappings are refused; private reply IDs belong to the recipient chat.
- Every generated chunk preserves the current bounded `tts.json` schema: voice/model,
  first audio byte, synthesis time and nested signal metrics. Unknown fields are
  discarded; invalid JSON, non-finite/huge values and unsafe metric files are refused.
  Aggregate generation time and decoded duration are sums; RTF is their ratio.
  Scope is generated segments only, including for raw-audio calls. First playback
  latency is null because it is unobserved. Completed segment metrics survive a later
  preparation failure. Raw audio receives the identified prefix and any provided
  transcript remains explicitly unverified.
- Canonical nonsecret `voice.json` selects the provider/model/voice. No neural failure
  falls back to host speech. An explicitly selected HA source may be owned by the
  current user or root, regular and non-writable by group/others; every path component
  refuses symlinks. Its exact unique entry ID must also have domain `fish_audio`.
  Voice config ownership remains current-user only. Missing Unix ownership APIs fail
  with safe codes. Secrets remain in the original source, outside repr/logs/argv.
- Dry-run reads voice configuration and session filesystem metadata, never `.env`,
  auth contents or TTS credential values. Account identity, source origin and recipient
  remain explicitly unverified. It does no synthesis/network/runtime bootstrap and
  creates no state; offline Python spawning disables bytecode writes. Safe TTS codes
  have actionable help, including nested call-preparation failure reasons.
- Journal queries include task/project filters, UUID validation and sanitized SQLite
  failures. Concurrent updates and permanent attempt tokens are covered. Generated
  audio is 0600 in private directories; concatenation reserves output exclusively.
  No failed/interrupted token or trigger claim is automatically replayed.

## Offline verification

Each direct Python invocation was bounded with `timeout 30s` or a combined 45-second
runner with a 15-second per-file limit. Commands use only injected effects, temporary
fixtures and local tools. Run a row with `python3 tests/<suite>.test.py`:

| Suite | Cases | Result |
| --- | ---: | --- |
| telegram-client | 14 | pass |
| telegram-conversation | 9 | pass |
| telegram-duplex | 5 | 3 pass, 2 dependency skips |
| telegram-providers | 7 | 6 pass, 1 dependency skip |
| telegram-call-lib | 7 | pass |
| telegram-user-account | 33 | 32 pass, 1 dependency skip |
| telegram-call-service | 21 | pass |
| telegram-tts | 17 | pass |
| telegram-tts-metrics | 18 | pass |
| telegram-761-tts-integration | 10 | pass |
| telegram-761-identity | 6 | pass |
| telegram-761-watch | 4 | pass |

Python total: **151 cases, 147 passed, 4 dependency skips**. The new TTS integration
uses the real `synthesize` implementation with an injected WAV provider response,
so actual `record_metrics` output reaches the journal for every chunk.

Final normal Bun discovery/frontdoor command:

```sh
HOME=/tmp/761-integration-test-home timeout 45s bun test \
  ./tests/telegram-client.test.ts ./tests/user-account.test.ts \
  ./tests/user-call-ledger.test.ts ./tests/user-call-tts.test.ts
```

Result: **40 passed, 0 failed, 197 assertions**, 10.89 seconds. Twelve Bun cases wrap
the Python suites above; these are overlapping evidence, not additional Python cases.
The other 28 cases cover frontdoors, shared store/stdin, context precedence,
credential-free dry-run, online app-registration forwarding and diagnostics.

Additional checks: `git diff --check` and `timeout 10s bash -n install.sh` passed.
A local real-ffmpeg smoke joined two generated 100 ms PCM WAV fixtures into a 200 ms
output and verified mode 0600; all fixture files were removed. A real Python dry-run
produced the exact quick introduction above, returned missing-session/config reasons
and unverified identity fields, and left its temporary config root empty.

Red-first evidence covered dropped metadata, NaN/huge/negative metrics, root ownership,
HA domain/duplicate IDs, absent getuid, parent symlinks, host-only preflight, long intro,
raw JSON mirror, history filters/UUIDs, SQLite error redaction, watcher identified flags,
and native provider preparation before refusal. Independent review additionally
reproduced eager `.env` and auth-record reads during dry-run; spy/raising-load regressions
failed before repair and pass afterward. Bytecode suppression was verified in an actual
spawned child. Two old Bun assertions were updated to require the intended new behavior:
no dry-run app secrets and no raw-audio bypass of the spoken introduction.

## Independent review

A fresh read-only `gpt-6-astra` sandboxed reviewer inspected the integrated source and
tests. It found the two P2 dry-run credential-read paths above, reviewed their repairs,
and returned **PASS: no unresolved P1/P2 findings**. It independently ran call service
(21), watcher (4), TTS integration (10), and `git diff --check`. No external review
service or network command was used.

## Integration boundaries and sandbox gaps

- Production native conversational `start` remains explicitly unsupported:
  `CONVERSATION_REQUIRES_IDENTIFIED_SERVICE`. Its audited live introduction/transcript
  path is missing. Consent, provider/media readiness and schema checks remain, but
  provider preparation and Telegram/native call effects do not run. The unreachable
  native transport body was removed; injected conversational APIs remain covered.
- The wider five-file Bun run also included unchanged `call-lib-adapter.test.ts`:
  two adapter tests passed; three failed at `proc.stdin.end()` with sandbox
  `EPERM: operation not permitted, write`, before their protocol assertions. Both
  adapter source and tests are unchanged in this worktree. These three checks need
  rerunning in a sandbox permitting Bun pipe writes; they were not weakened or skipped
  in code. The final four-file core run above is fully green.
- Known loopback `Bun.listen` auth fixture failures under this sandbox were not retried
  or weakened. Main's independent outside-sandbox evidence remains separate from this
  report. No full repository suite/build or dependency installation was attempted.
- Some overlapping worker Bun launches timed out waiting on the existing test lock;
  the final combined run acquired it normally. No lock or guardrail was bypassed.

## Live acceptance not performed

- Provider acceptance of the selected runtime voice/model, account entitlement, sound,
  intelligibility, voice identity, latency and independent ASR/listener evaluation.
- Real pyrofork private-chat send/edit contracts and recipient permissions.
- A separately consented end-to-end call, native media behavior and actual stream timing.
- Runtime profile installation: main owns private nonsecret configuration setup.

Offline fixtures do not establish that anyone heard audio. `audio_stream_ended` reports
only outgoing stream completion. There is no recording or capture of recipient replies.

## Release state

Changes remain uncommitted and unreleased, as requested. `CHANGELOG.md` records them
under Unreleased. Package versions remain unchanged because no release is performed.

Completion self-check: all eight requested integration areas have implementation and
offline evidence above. The explicit duplex boundary, sandbox-blocked adapter checks,
and live acceptance remain recorded under existing issue #761; none is presented as
completed live integration. No unrelated project, preferences or hooks were changed.

## Integrator checks outside the worker sandbox

The regular host umask reproduced a fixture-only failure: the new voice.json test
fixture was group-writable. Valid voice fixtures now explicitly use mode 0600;
production ownership/permission checks were not relaxed.

Offline preflight now selects an already completed, hash-matching cached Python
runtime (when present), without building dependencies or reading credentials.
The regression first failed by choosing system Python despite the completed cache;
then all four cache cases passed (ready, incomplete, missing interpreter, wrong hash).

Timing note: time_to_first_audio_byte_ms measures arrival of the first encoded
response byte, including the audio container header. It is not measured onset of
PCM speech, Telegram playback, or the listener hearing the call. WER/CER and
naturalness remain unmeasured without independent ASR/listener input.

Release: tg-cli 1.67.0. Final outside-sandbox suite and formal review evidence are
recorded separately in the issue/PR; earlier worker counts above are scoped runs,
not a claim that a live call or the whole repository suite was verified.
