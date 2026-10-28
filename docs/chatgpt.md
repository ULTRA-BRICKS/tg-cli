# ChatGPT session control (`tg chatgpt`, `/chatgpt`)

tg-cli is a **client** of `pm chatgpt api`. pm owns the ChatGPT sessions, the typed control
policy, the owner-approval worker and its single-use decision ledger; Guardian stays the only
browser sender. tg adds no policy and no second controller: it forwards typed requests, shows
what pm answers, and presents the owner's approval prompt in Telegram through the existing
`tg-ctl ask` machinery that pm itself uses. (Ticket: tg-cli#780.)

## Commands

```
tg chatgpt accounts                                 service + monitor health per account
tg chatgpt list [--workspace home|glide.vc|all]     watched sessions per account (default all)
tg chatgpt show <workspace> <chat>                  one session in detail, incl. its latest turn
tg chatgpt events [--workspace home|glide.vc|all]   recent monitor events (filtered list response)
tg chatgpt requests [<request-id>]                  approval requests / one request's status
tg chatgpt watch|unwatch|pause|resume <workspace> <chat>
tg chatgpt continue <workspace> <chat>              ask to send "go" on the CURRENT latest turn
tg chatgpt service start|stop <workspace>           ask to start/stop an account's guardian service
tg chatgpt connector list                           known connectors and install state
tg chatgpt connector request guardian               ask to install the reviewed guardian connector
tg chatgpt help                                     usage (also: tg help chatgpt)
```

`--json` (anywhere) prints one stable envelope: `{"ok":true,"result":…}` or
`{"ok":false,"error":{"code","message"}}` (secret-looking keys and values redacted). Without it the
output is concise English text; a missing optional field is an em dash, long fields are truncated.

Mapping to the frozen pm interface (`pm chatgpt api METHOD --params JSON`, one stdout envelope
`{ok:true,result}` / `{ok:false,error:{code,message}}`):

| Command | pm method(s) |
|---|---|
| accounts | `accounts.list {}` |
| list / events | `sessions.list {workspace}` (events prints only the response's events) |
| show | `sessions.get {workspace,chat}` |
| requests [id] | `requests.list {}` / `requests.get {request_id}` |
| watch, unwatch, pause, resume | `actions.request {workspace,chat,action,reason}` |
| continue | `sessions.get` then `actions.request {workspace,chat,action:'continue',expected_turn,reason}` |
| service start/stop | `actions.request {workspace,action:'service-start' or 'service-stop',reason}` |
| connector list / request guardian | `connectors.list {}` / `connectors.request {connector:'guardian',target:'chatgpt'}` |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | pm refused (error envelope), answered badly (invalid/oversize response), a read timed out, or `continue` could not learn the latest turn |
| 2 | usage error (unknown subcommand/option, extra args, bad workspace/chat/request id, `all` for a mutation): stderr, never a Telegram send |
| 69 | `pm` could not be started: not found in `PATH` or the fallback directories below, or found but not startable |
| 75 | a MUTATING request timed out or was stopped for oversize output: it may or may not have been queued; check `tg chatgpt requests`, **never retried** |

`tg chatgpt …` is dispatched before the generic send path and always exits with the CLI's code, so
a typo can never post a message.

## Safety model

- **Fixed argv, no shell.** The client runs exactly `['pm','chatgpt','api',METHOD,'--params',JSON]`;
  methods come from an allowlist; workspace is `home|glide.vc` (mutations refuse `all`), chat and
  request ids use bounded charsets (no leading `-`).
- **Bounded.** stdout at most 256 KiB, reads 20 s, mutations 30 s. The child runs in its own
  process group; a timeout or oversize output terminates the whole group, and the group is swept
  after exit, so no descendant is left behind.
- **Schema-bounded envelope.** Anything but a single `{ok:true,result}` / `{ok:false,error:{code,message}}`
  object is `invalid-response`; unknown extra keys are ignored.
- **No authority in tg.** Mutations never pass an approved flag, token, free-text command or
  recipient. They only QUEUE an approval inside pm (`Approval requested (id …); confirm in the
  approval prompt`); a tap or a typed "yes" in tg is never itself approval.
- **Continue is bound to a turn.** `continue` reads `sessions.get`, binds its latest turn as
  `expected_turn`, and refuses (nothing requested) if pm exposes no turn.
- **Uncertain mutations are never replayed.** A timeout of `actions.request` or
  `connectors.request` exits 75 / says "outcome unknown".
- **Redaction.** Output redacts `token|secret|password|authorization|api key|cookie…` keys and
  `Bearer …`, `key=value` secrets, long hex and base64-looking strings; control characters are
  stripped; display strings are truncated.

## `/chatgpt` in Telegram (owner only)

Owner enforcement is by user id as well as chat: a `/chatgpt` message or `cgp:` tap from another
allowlisted sender is dropped / answered "not allowed", and a negative (group) owner id fails closed.

`/chatgpt [home|glide.vc|all]` sends one message (escaped HTML) with the sessions per account and,
per session, buttons (rows of `n Details · n Pause · n Resume` and `n Watch · n Continue`), plus
`Requests` and `Refresh`. **Continue** appears only for a session whose listing exposes its latest
turn (Details always re-reads it).

Taps:

| Button | What happens |
|---|---|
| Details | `sessions.get`; a details message with fresh Pause/Resume/Watch/Continue buttons |
| Pause / Resume / Watch | `actions.request` and "Approval requested (id …); confirm in the approval prompt" plus a **Request status** button |
| Continue | re-reads `sessions.get`; if the latest turn differs from the one rendered: "State changed — refresh the /chatgpt menu"; otherwise `actions.request` with `expected_turn` |
| Requests / Request status | `requests.list` (status buttons for the first 5) / `requests.get` |
| Refresh | re-renders the menu with fresh buttons |

Callback data is `cgp:<22-char random id>` (at most 64 bytes) and carries nothing else. The meaning
(`{kind, account, chat, expected turn, request id, owner chat id, created/expires (15 min), used}`)
lives in the durable store `CtlPaths.chatgptRefs` (`tg-ctl.<bot>.chatgpt-refs.json`, atomic
tmp+rename, 0600), a **fixed schema validated on every read**; it never holds pm JSON or chat text.
Account and chat are stored together, so the same chat id in `home` and `glide.vc` stays two targets.

Authorization reuses the existing boundary in `stepUpdates`: the sender must pass `senderAllowed`
(configured chat id / `allowedSenders`, nothing hardcoded) **and** the tapped message must sit in the
configured owner chat; no owner configured (0 / not an integer) gives "not allowed". An unknown,
forged, expired or already-used ref gives "expired", with zero pm calls. A valid ref is marked used
durably **before** the pm call (a failed write means no call), so replays and concurrent double
taps cannot duplicate a request; if a request's outcome is unknown the reply says so and it is not
retried. The pm calls run off the poll loop (at most 4 in flight, each bounded). No second
`getUpdates` poller and no new `allowed_updates`.

The UI proof from a fixture lives in `docs/chatgpt-ui/` (`menu.html`, `menu.keyboard.json`,
`details.html`, `menu.png`); regenerate with `bun scripts/render-chatgpt-ui.ts`.

## Assumed pm result shapes (tolerant parse)

Unknown keys are ignored; missing optional fields render as `—`; nothing is fabricated.

- `sessions.list`: `{workspace, accounts:[{workspace,ok,error,stale,generated_at,summary:{enrolled,present,running,blocked}}], sessions:[{account,chat,title,status,reason,continuation,model,effort,last_checked_at,last_go_at,last_go_state,next_check_at}], events:[{account,at,chat?,kind,message}]}` (the existing monitor shape). `chat` may be a URL; the API chat id is its last path segment.
- `accounts.list`: `{accounts:[{workspace,configured,service:{active,error},monitor:{ok,error,stale,sessions,enrolled,running,blocked}}]}`.
- `sessions.get`: the session at `result.session` (or the result itself). The **latest turn** is read from the first present of `latest_turn`, `latest_turn_id`, `turn`, `turn_id`, `last_turn`, `expected_turn`; pm is asked to expose `latest_turn`.
- `requests.*` / `connectors.*`: `{request_id,status,action,workspace,chat,expected_turn,expires_at}`; lists as `{requests:[…]}` / `{connectors:[…]}` or bare arrays.

## Limitations

- tg cannot verify a request was approved or executed; it only shows pm's receipt/status.
- `continue` needs pm to expose the latest turn in `sessions.get`; otherwise it refuses.
- The list menu shows at most 10 sessions (`tg chatgpt list` shows all); Requests shows status buttons for the first 5.
- Old menu buttons expire after 15 minutes; the ref store survives a daemon restart.
- `tg chatgpt` and the daemon look for `pm` in `PATH` and a few fallback directories, see [the daemon's environment](#the-daemons-environment-and-missing-prerequisites-tg-cli804).

## The daemon's environment, and missing prerequisites (tg-cli#804)

`/chatgpt` (`pm`) and `/spend` / `/daily` (`rig`) run from the `tg-ctl` daemon, not from your shell.
Under launchd the daemon's `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`; a tool that works in your
terminal can be invisible there. The daemon therefore looks for exactly these two CLIs — by absolute
path, no shell, never a relative `PATH` segment — in this order, **on every command**:

1. the daemon's own `PATH`;
2. `~/.local/bin`, `~/.files/bin` (only with an absolute, non-root `$HOME`);
3. `/opt/homebrew/bin`, `/usr/local/bin`.

The child gets the daemon's `PATH` unchanged with the tool's directory and the directories above
appended, so the tool's own helpers (`gh`, `git`) are found as well. Because the lookup is repeated per
command, installing or repairing `pm`/`rig` while the daemon runs needs **no restart**: send the command
again and it shows the real result. (`tg-ctl restart --if-stale` is only for picking up new tg-cli code.)

When the tool cannot be run, the Telegram reply names the feature and the classified problem instead of a
raw spawn error:

| Class | Reply says | Meaning |
|---|---|---|
| not found | "needs the `pm` CLI, but the tg-ctl daemon cannot find it" + the searched `PATH` and directories | not installed, **or** installed somewhere the service cannot see (one lookup cannot tell these apart) |
| found but not startable | "found at <path> but could not be started (<reason>)" | broken: the OS refused to start an executable, e.g. a missing interpreter (a file without the executable bit counts as not found) |
| tool ran and failed | the tool's own typed error / `exit N` text | pm account or rig problems, never reworded as an install problem |
| valid empty / unavailable metric | `(no sessions)`, `n/a (unpriced model)` | a real answer, not a failure; nothing is fabricated |

### Not covered here

- The shared one-button **Install and configure / Repair** action belongs to tg-cli#803; until that
  installer exists the reply carries text only (no dead buttons) and does not invent an install command.
- The autostart unit / plist still does not pin a `PATH` (that would change the byte-identical lib
  shape); the per-command fallback above makes `pm`/`rig` work under the default launchd `PATH` instead.
  Other tools the daemon spawns still see the service `PATH` (tg-cli#767).
- An OMP session connected through the original-process bridge needs no tmux pane for these commands:
  the daemon integration test runs with a tmux that has no server, and the live bridge state is read
  from `tg-ctl status` (`bridge` vs `NO bridge`) before and after a deploy.
- **macOS launchd host proof is not available** on the development hosts: the launchd default `PATH` is
  reproduced by the platform-independent tests (`tests/daemon-cli-resolution.test.ts`,
  `tests/chatgpt-daemon-integration.test.ts` with `PATH=…:/usr/bin:/bin`), not by a real launchd job.
