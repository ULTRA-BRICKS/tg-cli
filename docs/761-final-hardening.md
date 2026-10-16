# Issue 761 final review hardening

This report covers follow-ups to checkpoint `ad356a3` on
`fix/call-complete-20261016`. The existing issue #761 remains the work item. These
changes are local, uncommitted and undeployed. No network, credential reads, live
calls/messages, dependency installation or changes to the running deployment were
used. Main's concurrent full remote suite tests the earlier checkpoint; it does
not validate the follow-ups described here.

## Snapshot consistency

History reads explicitly begin one read transaction before fetching rows and their
transitions. A real second SQLite writer in a WAL fixture commits completion after
the reader has selected its rows. The regression initially returned `attempting`
with an `audio_stream_ended` transition; the repaired reader returns one coherent
snapshot, and a subsequent fresh read sees completion. Read-only opening, missing
journal behavior and private file modes remain covered.

## Bounded WER/CER

Source and normalized transcripts are limited to 10,000 characters. NFKC expansion
is checked before allocating edit-distance work. Exact matching prefixes and suffixes
are trimmed, then the remaining WER and CER matrix products are summed and must not
exceed **2,000,000 cells** before either quadratic computation starts. Accepted
comparisons retain exact Levenshtein WER/CER; oversized normalized text or remaining
work raises a safe `ValueError`. Equality and near-equality can remain cheap after
trimming, while long differing strings cannot reach unbounded dynamic programming.
Missing ASR remains null.

The red tests guarded the distance boundary to avoid executing the old enormous
matrix. They reproduced unchecked NFKC expansion with FDFA × 10,000 and ß × 6,000,
and unchecked work with differing 1,500-character strings. Equal and near-equal long
strings and the original ordinary WER/CER sample are covered.

## Persistence and observed outcomes

Mandatory intent, mirror/preparation and attempt writes still fail closed: no call
is placed if those writes fail. Once a dial returns or raises, its observed outcome
is retained in memory before attempting a terminal write. A failed journal write
is not retried by the failure handler or final mirror handler. There is no redial.
Telegram status edits and their persistence are handled separately, so a successful
edit followed by a failed database write remains an observed successful edit.

The structured result keeps `call_id`, `state` and the existing failure shape
(`ok: false`, `error: CALL_ATTEMPT_FAILED`, safe `reason`, `stage`). Additive fields
make the limits of the audit explicit:

- `state`: the observed terminal call outcome, including `audio_stream_ended`.
- `saved_state`: the last journal status whose write returned successfully; it is
  not a claim that the observed completion was saved.
- `persistence_failed`: whether an audit write failed.
- `audit_warning`: `CALL_JOURNAL_WRITE_FAILED` on persistence failure, otherwise null.
- `mirror_result` and `mirror_warning`: the observed final edit result and safe
  error code/class, separate from the journal warning.
- `automatic_retry`: false.

A successful dial with failed audit persistence still returns the observed success
and exits 0 through the existing CLI contract. A failed call still returns
`ok: false` and exits 3. Inside the service, cancellation/keyboard interruption remains raised; its
exception carries a safe `call_result` diagnostic object with the same call ID,
observed status and audit fields. An original cancellation is preserved even when
the mirror edit also cancels. Diagnostics never include exception messages,
credentials or provider request contents. The CLI catches those interruptions,
emits the attached safe diagnostics with `ok: false`, `error: INTERRUPTED` and
exits 130.

The new parameterized regressions first produced 12 errors: database failures
masked successful edits, completed calls, original failures and cancellation,
including mandatory pre-dial writes. Green coverage adds successful edit plus write
failure, terminal write failure after successful dial, mirror error plus database
failure, original failed call plus failure-write failure, cancellation plus database
failure, nested mirror cancellation and timeout, and every pre-dial update boundary.
Tests inspect the real temporary journal's last saved state and the actual rendered
mirror anchor, and require one dial at most and one failed audit write.

## Scoped verification

All commands use injected online effects and temporary fixtures. No full local Bun
suite or guard override was run. These counts are separate affected suites, not a
claim about the whole repository.

| Command | Result |
| --- | --- |
| `timeout 20s python3 tests/telegram-call-journal.test.py` | 7 passed, 0.035 s |
| `timeout 25s python3 tests/telegram-tts-metrics.test.py` | 28 passed, 1.508 s |
| `timeout 40s python3 tests/telegram-call-service.test.py` | 24 passed, 0.514 s |

## Remaining live-provider gap

Offline tests do not verify provider entitlement, the selected live voice/model,
actual sound, intelligibility, latency, independent ASR/listener assessment,
pyrofork's real private-chat send/edit behavior or native call playback. A separately
consented live acceptance remains required. The installed nonsecret voice profile
and its credential source were not inspected. `audio_stream_ended` means outgoing
stream completion; it does not establish that the recipient heard audio. Production
native conversational `start` remains explicitly unsupported until its audited
introduction/transcript integration is complete, as documented in
[761-integration.md](761-integration.md).

## CLI payload and preflight boundaries

JSON stdin has a **2 MiB serialized UTF-8 byte cap**, checked before planning or any
online effect. This accommodates a 100,000-character transcript, a 1,000-character
source and twelve 512-character metadata fields even when each character occupies
12 bytes as a JSON surrogate-pair escape. Existing decoded field limits remain
unchanged. Oversized raw payloads, including trailing whitespace, are rejected before
`call_plan` or `run_call`.

Preflight has one canonical structured reason collection. Its missing-component
list is derived from that collection, so a missing caller session has one
`session` component and a structured `SESSION_MISSING` reason, without duplicate
entries mixing codes and components.
Exact-content regressions also cover the personal session, absent TTS configuration,
ffmpeg/dependency codes and zero new filesystem state.

Help now describes configured neural TTS, explicit host-voice opt-in, no silent
fallback and the limited meaning of `audio_stream_ended`. It names the actual
journal path `<config>/mtproto/calls/journal.sqlite3`. Read-only history/dry-run tests
assert that this path and its state directories are not created.

The CLI regression initially failed 2 tests plus 3 subtest errors: newline,
backslash and astral 100,000-character transcripts were rejected, an oversized
payload with trailing whitespace reached effects, and missing reasons were
duplicated. The unchanged decoded field-limit regression already passed. The
help contract first failed against the old wording, then passed with 8 assertions.

Additional scoped results:

| Command | Result |
| --- | --- |
| `PYTHONDONTWRITEBYTECODE=1 timeout 20s python3 tests/telegram-cli-hardening.test.py` | 6 passed |
| `timeout 45s bun test ./tests/user-account.test.ts --test-name-pattern 'call help describes'` | 1 passed, 8 assertions, 17 filtered |
| `PYTHONDONTWRITEBYTECODE=1 timeout 20s python3 tests/telegram-user-account.test.py` | 33 cases: 32 passed, 1 dependency skip |
| `timeout 20s python3 tests/telegram-761-watch.test.py` | 4 passed |
| `timeout 20s python3 tests/telegram-761-tts-integration.test.py` | 10 passed |

The bounded Bun help run acquired the existing host test lock normally; it was not
bypassed. Its wrapper emitted a read-only cache `mktemp` warning. An independent
read-only worker reran the journal and metrics suites and checked 961 short CER
pairs against a full-matrix oracle with no findings.

Independent review identified two adjacent interruption diagnostics gaps. First,
a later mirror cancellation could drop the original failed dial's reason/stage;
the new service regression reproduced missing `ok` in the attached diagnostics,
then passed after constructing failure diagnostics before re-raising cancellation.
Second, the real CLI boundary discarded service cancellation diagnostics: the red
regression produced a missing state for keyboard interruption and an uncaught
`CancelledError`. The repaired CLI emits observed cancellation plus the call ID,
last confirmed `attempting` status, safe audit warning and exit 130. Both variants
assert a single dial and a single failed terminal write against a real temporary
journal. These checks run through the production CLI and service with fake online
effects; they do not place calls.

Final independent review found no further issues in the modified boundaries.
Its separate bounded Python reruns passed all 24 service, 6 CLI, 28 metrics and
7 journal tests. A full-matrix oracle also matched both WER and CER for 14,641
short input pairs containing letters and spaces, exercising normalization and
common-edge trimming. This review adds no live-provider or full-suite coverage.

## Final CLI integration corrections

A real process SIGINT, unlike a directly raised fake cancellation, makes
`asyncio.run` replace `CancelledError` with a fresh `KeyboardInterrupt`. A new
regression reproduced the lost call ID and outcome for both healthy and failed
terminal audit writes. The CLI now captures the diagnostic inside the coroutine
before that conversion; both real-signal variants return exit 130 with their call
ID, observed outcome and last saved state, without exposing private exceptions.

The human CLI also explicitly prints CALL_JOURNAL_WRITE_FAILED with call ID,
observed state and saved state on success, failure and interruption. JSON mode
stays exact machine-readable JSON without extra stderr. The regression failed
when audit loss was silently omitted, then both tests passed with 17 assertions.

Shared call fakes now live in an importable test-support module. Service, CLI,
preparation and TTS-integration suites import it instead of executing another
test suite through runpy. No test runner or sys.path mutation occurs in the
support module.
