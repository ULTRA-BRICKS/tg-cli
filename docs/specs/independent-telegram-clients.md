# Telegram user account and calls (`tg auth user`, `tg call`, `tg user send`)

The user wants one `tg` that agents and people use for everything Telegram: the bot channel
(`tg auth`, tg-cli#561) AND acting as the user's own Telegram account — reading/sending as the
user and placing voice calls — with a login that is one command, not hand-edited tokens and ids.
Bot API cannot do either (no user identity, no calls), so this runs over MTProto in a Python
sidecar (pyrofork + py-tgcalls + ntgcalls — the stack HyperCalendarBot already places calls with).
No login, call, send or historical event ever runs implicitly.

## 1. Command surface (in `tg`)

Exact-match leading tokens, like `replies`/`voice`: `tg "call me"` (one quoted argument) still
sends a message. `tg auth user|caller …` is part of the one `tg auth` parser and help
(docs/specs/tg-auth.md §2, §9): `parseAuthArgs` hands everything after `user`/`caller` to
`parseAccountAuth`, `tg help auth` documents both halves, and plain `tg auth status` shows the
two accounts next to the bot (read offline from the session files). `tg call` and
`tg user send` are parsed by `parseUserAccountArgs`.

| Command | Does |
|---|---|
| `tg auth user [--qr] [--expected-id N]` | Log in the user's own account (role `personal`). |
| `tg auth caller [--qr] [--expected-id N]` | Log in a separate service account (role `caller`) used to ring the user. |
| `tg auth user\|caller --import-session FILE --import-config ENV [--expected-id N]` | Optional: import an existing pyrogram SQLite session (HyperCalendarBot's `voice_caller.session` + its `.env`) instead of logging in. |
| `tg auth user\|caller status [--online] [--json]` | Offline: configured? which account id. `--online` adds a `get_me` check. Exit 0 configured, 3 missing. |
| `tg auth user\|caller logout` | Delete the local session file. The authorization stays in Telegram's Settings → Devices until the user terminates it there (an imported key is shared with its source app; a remote log-out would kill that app). |
| `tg call <peer> (--say TEXT \| --audio FILE) [--from user\|caller] [--timeout S] [--dry-run] [--json]` | Ring `<peer>` and play the audio (or TTS of `--say`) once. |
| `tg user send <peer> [TEXT…]` | Send TEXT (or stdin) as the user. `--dry-run`, `--json`. |

`<peer>`: `@username`, a numeric user id, or `me`. For `tg user send`, `me` is the user's Saved
Messages. For `tg call`, `me` means the user's own account: an account cannot ring itself, so
`tg call me` places the call FROM the caller account (implies `--from caller`); `--from user`
with `me` is a usage error. `--from` defaults to `user`.

`--dry-run` connects to nothing: it checks the session file, the audio file or TTS engine,
ffmpeg and the call libraries, and prints the plan.

**Flag values never swallow flags.** A value-taking flag (`--say`, `--audio`, `--from`,
`--timeout`, `--expected-id`, `--import-session`, `--import-config`) followed by a word that
starts with `-` is a usage error (exit 2) — `tg call @a --say --dry-run` must not become a real
call that speaks "--dry-run". Dash-leading values use the `=` form (`--say=-5 °C outside`); a
value that is exactly one of the command's own flags (`--say=--dry-run`) is refused too. A
boolean flag given a value (`--dry-run=1`) is an error. `tg user send` accepts `--` to end
options (`tg user send @a -- --not-a-flag`); `tg call` takes no free text, so it has no `--`
and a `--`-prefixed word can never become its peer. `tg` hands every value to the sidecar in
the `--flag=value` form so Python's argparse cannot misread a dash-leading value either.

### Login (one command)

1. API ID/hash (MTProto requires an app registration; Telegram offers no way around it):
   `TG_API_ID`/`TG_API_HASH` (process env, then `<configDir>/.env`) → the other role's stored
   app credentials → a hidden prompt naming https://my.telegram.org/apps.
2. Phone flow (default): phone, code, then the 2FA password only when Telegram asks. All
   prompts are hidden (`getpass` on the terminal). No terminal on stdin → `LOGIN_REQUIRES_PRIVATE_TERMINAL`.
3. QR flow (`--qr`): pyrofork's `sign_in_qrcode` (auth.exportLoginToken, DC migration handled
   by the library). The QR is drawn on stderr; scan it in Telegram → Settings → Devices → Link
   Desktop Device. A new QR replaces an expired one until a 5-minute deadline; 2FA is prompted
   after the scan when the account has it.
4. Identity: `get_me` must be a user, not a bot. `--expected-id` (optional) must match, else the
   new authorization is logged out and nothing is saved. The caller account must differ from
   the stored personal account. The logged-in id becomes the session's `expected_id`; every
   later connection checks it.
5. An existing session is never overwritten (`SESSION_ALREADY_EXISTS` → "logout first").

### Storage

`<configDir>/mtproto/` (`configDir` = `$TG_CTL_CONFIG_DIR` or `~/.config/tg-cli`, the directory
`tg` already uses), mode 0700, owner-checked; `personal.json` and `caller.json`, 0600, created
with `O_EXCL|O_NOFOLLOW`, fsynced, never overwritten; role locks next to them. Each holds
`{expected_id, api_id, api_hash, session, origin}` — `session` is a pyrogram session string
(the account's auth key: anyone with the file IS the account), `origin` is `login` or `import`.
A file whose `origin` is missing is treated as `import`. Session strings never appear in argv,
output, logs or Git. The previous default `~/.local/share/tg-cli/auth` was dropped: that
directory is where `install.sh` clones the tg-cli repo itself, so sessions would sit untracked
(and not git-ignored) inside a live checkout.

### Sidecar runtime and handoff

`tg` stays Bun; it only parses the command, checks the session file exists (so "not logged in"
is instant and needs no Python), and spawns the sidecar:

- argv: `<python> -m telegram_client <personal|caller> --store=<configDir>/mtproto <command> …`
  with `PYTHONPATH=<repo>/features` — the sidecar code runs from the same checkout as `tg`.
- `<python>`: a managed venv `$XDG_CACHE_HOME/tg-cli/mtproto-runtime-<sha256(requirements-call.txt)[:12]>`
  (default `~/.cache/…`), built on first use with `uv venv --python 3.12` +
  `uv pip install --require-hashes -r requirements-call.txt`, and marked ready
  only after that succeeds. A lock change gets a fresh venv. `uv run --with-requirements` is NOT
  used: it installed a requirement whose hash did not match (observed with uv 0.12.24).
- One builder at a time: an atomic `mkdir` lock `<venv>.building` holding the builder's pid.
  A waiter takes the lock over only when its owner is gone (pid not alive, or no pid written
  after 60 s); a live owner is never overridden. Each install step is killed after 10 minutes,
  so a waiter waits as long as a live build can legitimately take (every step at its timeout,
  plus 2 minutes) — never less. If the owner is somehow still alive after that, the error names
  its pid and says to let it finish or stop that process (its lock clears itself once it
  exits); it never tells anyone to delete the lock.
- `TG_MTPROTO_SIDECAR=<executable>` replaces `<python> -m telegram_client` (a pre-built runtime,
  or a test fake). Then no venv is built.
- env: the caller's environment, plus `TG_CTL_CONFIG_DIR=<configDir>` and `TG_API_ID`/`TG_API_HASH`
  from `<configDir>/.env` when the process env lacks them. The bot token is not added.
- stdio: stdin and stderr inherited (prompts, QR, progress); stdout is JSON lines that `tg`
  turns into one human line (`--json` prints them raw). For `tg user send` the text goes on the
  sidecar's stdin, never in argv.
- Errors are stable codes (`SESSION_MISSING`, `SESSION_ALREADY_EXISTS`, `PEER_NOT_FOUND`,
  `TTS_UNAVAILABLE`, …), optionally with `detail` = the exception CLASS name (never its message,
  which may carry auth data). `tg` maps each code to WHAT/HOW text. Exit codes: 0 ok; 2 usage;
  3 refused with a code (not logged in, safety gate, peer not found, call not completed, a
  dry run that is not ready); 1 operation failed with an unexpected exception; 130 interrupted.

### Calls

One dial, no redial. `audio_stream_ended` means the outbound audio stream ended
(py-tgcalls `StreamEnded` for the microphone), not proof the recipient heard it;
ringing or a declined call is `CALL_INCOMPLETE`. `--timeout` bounds the
ring (default 60 s) and the playback separately. `--say` synthesizes into a private temp dir
deleted after the call using configured neural TTS from canonical `voice.json`.
Host voices (macOS `say` or `espeak-ng`) require explicit opt-in with provider `host`;
neural failures never silently fall back to host speech. Text is private input, never argv.
The journal is `<config>/mtproto/calls/journal.sqlite3`; offline history and dry-run
create no journal or call state. Private JSON stdin has a 2 MiB UTF-8 byte cap,
including JSON escaping and whitespace. This covers worst-case escaping of all legal
fields (100,000-character transcript, 1,000-character source, twelve 512-character
references); decoded field limits still apply. Text over 1000 characters → `TEXT_TOO_LONG`.
A peer given as `@username` is resolved with `get_users`; a bot is refused. A numeric id works only when Telegram lets the
account resolve it (a contact or a recent chat).

## 2. Boundaries

- `tg-mtproto` / `tg-call` (and `python -m telegram_client personal|caller`): the expert surface
  — dialogs/history, arm/watch-call, conversational `start`, doctor. Same store, same code.
- Python adapters import Pyrofork/py-tgcalls lazily. Neither HyperCalendarBot nor qa-cli is imported.
- Every online connection checks get_me against the expected account and rejects bots. Missing/unauthorized sessions never invoke login. Imports do not establish online identity proof.

## 3. Migration (optional `--import-session`)

qa-cli uses browser restoration, not a supported MTProto export. Browser state/key scraping is explicitly excluded.

For an imported session, read the selected existing API/identity fields in-process, open the original SQLite with mode=ro and use SQLite backup (including committed WAL) into a private temporary copy. Only the copy is opened by Pyrofork. Compare its stored account ID against an independently confirmed expected ID, export through the library and save privately with `origin: "import"`. Never print the string or read original session rows directly. Clean up the temporary copy. A missing expected identity refuses migration; the optional --expected-id must be independently confirmed and cannot contradict the source configuration.

An offline copied key is NOT an independent Telegram authorization. A local role lock prevents duplicate tg-cli owners but cannot coordinate a different host/application using the same authorization. Every online use of an `import`-origin session therefore requires `--source-session-idle-confirmed` (`tg call --source-idle-confirmed`); deployment must coordinate ownership before using this flag. A `login`-origin session is tg-cli's own and needs no such flag. No production migration, shutdown, or ownership change is automatic.

## Event/call lifecycle

Arming records verified owner, explicit peer, latest message ID and activation timestamp. Real incoming private updates must match owner+peer, exceed both timestamp and ID watermark, and be incoming. One SQLite conditional update durably claims the event before the external call. Parallel duplicates, later messages, history replay and process restarts cannot start another call. A crash while claimed or unsuccessful call requires manual reconciliation: no automatic retry. A completed outbound audio stream marks completed; ringing/queueing is not completion. Remote listening/non-silent media still needs separate real-call verification.

The notification audio is prepared separately and supplied explicitly; for the Tony use case its speech must be “Тони написал в Telegram”. No audio is generated or call placed by doctor, import, or arm. The trigger is not active unless watch-call is running on a persistently available host.

## Verification limits

Credential-free tests cover account mismatch, missing auth, store separation and permissions, source WAL backup, failure redaction, concurrent event dedup, restart and uncertain-result behavior; phone/2FA/QR login and identity gates against a fake client; peer parsing and resolution; TTS selection; the `call --dry-run` plan; and the exact argv/env/stdin `tg` hands the sidecar (a fake sidecar via `TG_MTPROTO_SIDECAR`). The runtime build and imports (pyrofork, py-tgcalls, ntgcalls, qrcode on Linux x64, Python 3.12) were proven on the dev host. Live login (needs the user's phone code), a live send, a live call and its audio, the Tony identity and server supervision remain manual acceptance steps — the checklist is tracked in its own issue; unit tests do not prove them.

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
`requirements-voice.txt` preserves the source macOS CPU dependency pins. No production
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

## Identified-call service (#761)

The current one-shot call owner is `telegram_client.call_service.run_call`. `tg call`,
`call-cli` (thin Bun entrypoint) and `tg-call call` all reach it and reuse the existing
MTProto store. The `tg`/`call-cli` sidecar payload carries speech, transcript and context
as JSON on stdin; subprocess argv carries routing/safety options only. The expert Python
`--say` interface remains compatible; scripts should prefer `--say-stdin`.

Preparation composes a Russian introduction in agent → kind → task/project → content order.
`--agent`, `--task`, `--project`, `--session`, corresponding `--NAME-title`/`--NAME-url`, and
`--kind report|question|problem` are explicit overrides. Registry ancestry supplies a session
reference/title and agent label where available; `TG_SESSION` and `RIG_AGENT_ID` are fallbacks.
A session name/cwd/PID is never invented as a task id. Speech is brief: `Привет! 3d-house. Проблема с Print Ops. …`; report/question use `по`. Missing agent/task remain unknown; an absent project is omitted while every supplied reference stays in history.

Intent and append-only transition rows commit to private SQLite before network resolution.
History has UUIDs, UTC times, host, caller/recipient ids, source/intro/spoken text, each TTS
segment's sanitized metadata, mirror ids and failures. `call history list|show --json` reads
without opening Telegram or initializing the database. Filters: status, agent/session/task/project id,
recipient id, limit. Reusing `--idempotency-key` refuses a second attempt, even after failure.
An intent/attempt left by a hard kill is evidence requiring manual reconciliation, not a
retry request. No automatic redial, listening receipts, recordings or fictional reply text.

The verified calling account sends into the resolved user's private chat (including when
`me` resolves to the configured personal owner). A bounded readable anchor carries call id/status, UTC time, agent/kind, task, supplied project/session references and caller/recipient ids;
complete transcript chunks reply to it. Explicit `ParseMode.DISABLED` preserves literal
hostile markup. All chunks must be acknowledged before preparation/dial. Failures are
journaled and visible; partial mirrors block dialing. An outcome edit failure preserves
the actual transport outcome and emits a warning. Bot topics and bot reply ids are never
reused in another account's private chat: topics fail closed; `--reply-to` explicitly names
a message in the recipient's private chat. No transcript is redirected to the owner for
arbitrary peers.

Raw audio is prefixed using TTS plus bounded ffmpeg concatenation. Its content is unknown
unless the caller provides `--transcript`, which is labeled unverified rather than recognized
speech. TTS input chunks preserve the complete introduction/content within the existing
per-request bound. TTS uses the canonical config directory and each segment's sanitized `tts.json` schema, retaining provider/model/voice identity, first audio byte time, total synthesis time and nested audio metrics; aggregates report measured generation/audio/RTF, without inventing first playback time. Offline dry-run reports the composed plan, does no TTS/network,
creates no journal/mirror state, and never builds/downloads a runtime.

Support boundary: `watch-call` routes a claimed trigger through the same identified service, journal and pre-call mirror; a watermark claim never retries automatically. Production native conversational `start` fails with `CONVERSATION_REQUIRES_IDENTIFIED_SERVICE` before connecting or preparing providers because audited real-time intro/transcript delivery is unsupported.
Injected offline conversational library tests retain their fake backend behavior. This
checkpoint does not claim full real-time transcript support. No production credentials,
real call, Telegram mirror or TTS provider acceptance was exercised by the implementation
worker. `docs/761-integration.md` records the final integration evidence and supersedes the workers’ earlier handoff gaps.

`call-cli` is a Bun frontdoor installed by the root `install.sh` beside `tg`; it is not a Python console script from `pip install`. It uses the same `<config>/mtproto` sessions and voice configuration, without copying credentials.
