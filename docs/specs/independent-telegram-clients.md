# Independent Telegram clients (initial implementation)

The user requested tg-mtproto and tg-call inside tg-cli, without runtime calls into qa-cli or HyperCalendarBot. The immediate objective is one new incoming message from a verified contact causing one notification call to the personal account owner. No login, test call, or historical event may run implicitly.

## Boundaries

- `tg-mtproto`: explicit user-operated MTProto login, offline doctor/status, optional online identity verification, bounded dialogs/history, arm and watch-call.
- `tg-call`: offline service-session migration, doctor/status, notification audio call.
- Python adapters import Pyrofork/py-tgcalls lazily. Neither application is imported. Credentials live in separate `personal.json` and `caller.json` under `~/.local/share/tg-cli/auth`, owner-only directory/files; stores are never overwritten. No credentials in arguments, output or Git.
- Every online connection checks get_me against the expected account and rejects bots. Missing/unauthorized sessions never invoke login. Imports do not establish online identity proof.

## Migration

qa-cli uses browser restoration, not a supported MTProto export. Browser state/key scraping is explicitly excluded. Personal login is provided but requires a separate human authorization step, existing API credentials, a confirmed account ID, and a private interactive terminal.

For the service account, read the selected existing API/identity fields in-process, open the original SQLite with mode=ro and use SQLite backup (including committed WAL) into a private temporary copy. Only the copy is opened by Pyrofork. Compare its stored account ID against an independently confirmed expected ID, export through the library and save privately. Never print the string or read original session rows directly. Clean up the temporary copy. A missing expected service identity refuses migration; the optional --expected-id must be independently confirmed and cannot contradict the source configuration.

An offline copied key is NOT an independent Telegram authorization. A local role lock prevents duplicate tg-cli owners but cannot coordinate a different host/application using the same authorization. Online caller commands therefore require --source-session-idle-confirmed; deployment must coordinate ownership before using this flag. No production migration, shutdown, or ownership change is automatic.

## Event/call lifecycle

Arming records verified owner, explicit peer, latest message ID and activation timestamp. Real incoming private updates must match owner+peer, exceed both timestamp and ID watermark, and be incoming. One SQLite conditional update durably claims the event before the external call. Parallel duplicates, later messages, history replay and process restarts cannot start another call. A crash while claimed or unsuccessful call requires manual reconciliation: no automatic retry. A completed outbound audio stream marks completed; ringing/queueing is not completion. Remote listening/non-silent media still needs separate real-call verification.

The notification audio is prepared separately and supplied explicitly; for the Tony use case its speech must be “Тони написал в Telegram”. No audio is generated or call placed by doctor, import, or arm. The trigger is not active unless watch-call is running on a persistently available host.

## Verification limits

Credential-free tests cover account mismatch, missing auth, store separation and permissions, source WAL backup, failure redaction, concurrent event dedup, restart and uncertain-result behavior. Live personal auth, exact Tony identity, media capability and server supervision remain deployment acceptance gates; unit tests do not prove them.

## Duplex integration checkpoint (2026-10-02)

Extract the HyperCalendarBot native bridge contract into `duplex.py`, using direct
injected ports rather than a calendar API or business agent. Keep the existing
48 kHz PCM16 mono/32 ms input and sequence header contract, file PLAY/PLAY_DONE,
skip_stream interruption, record capture and hangup cleanup. Tests use fake native
I/O; an additional no-network test binds the actual pinned PyTgCalls event classes.
Bracho remains a named unresolved profile: AISIS spec 140 identifies a persona but
contains no confirmed acoustic preset/sample. Never fall back to xenia.

The bounded acceptance criterion is local duplex fake-audio integration plus a
no-call doctor/smoke command. It is not real Telegram audio or provider acceptance.

## Provider activation and offline readiness

`providers.py` supplies Nova-3 RU over aiohttp WebSocket, a generic CallAgent
executable binding, local Silero package TTS in a cancellable subprocess, and
verified TorchScript Silero VAD. Provider constructors/imports do not contact
external services. STT creates a per-utterance socket and fences finals by epoch
and generation; finalization does not block incoming native audio. Errors end the
call instead of silently leaving an unanswered provider turn. Child processes are
reaped on timeout/cancellation and stdout is capped. Local weights require an
explicit path plus SHA-256; no torch.hub downloads and no default voice.

Offline doctor reports configuration, environment-variable presence, executable
presence, model hashes and import availability separately from live verification.
`voice-runtime.lock` preserves the source macOS CPU dependency pins. No production
credentials or weights have been installed. `attach_configured_session` is a
library entry point for a separately authorized, already connected call.

## Shared library and consumer wiring

The user authorized completing packaging, conversational CLI start and a prepared
calbot adapter in the isolated checkout, with no running-calbot mutation, paid
provider calls or real calls. Package the existing feature module as the single
`tg-call-lib` Python distribution; keep entrypoints thin, following repo conventions.
`call_lib.start_conversation` owns preflight, provider preparation, independent
caller lifetime, one dial attempt, timeout and cleanup. CLI and JSON bridge use
that exact function; the calbot TypeScript adapter invokes the installed bridge.
Version identity is exposed offline. Tests inject one fake owner and real mock
audio through both consumers and compare module/version identity.

Start requires explicit call/provider/source-idle consent, configured providers,
confirmed named voice and agent protocol, plus a production-ready JSON wrapper
metadata handshake before opening Telegram. Mock wrappers are never live-ready.
Missing auth never triggers login; no retries/redial. Workspace model copies need
source hash equality and retained license; they are not included in the wheel.

Implementation steps: red CLI/package tests; shared owner/package/JSON runner;
consumer identity and fail-closed tests; wheel build and isolated offline install;
VAD copy with MIT/receipt; relevant Python/Bun/type/build gates and separate commit.
