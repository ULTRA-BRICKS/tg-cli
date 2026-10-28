# Remote ctl server (`control.server`) — design, wire contract, plan

Ticket: [tg-cli#831](https://git.hyperide.ai/ultrabricks/tg-cli/issues/831). Owner request 2026-10-28:
«Добавь в tg-cli возможность указать в конфиг сервер где бежит ctl, настрой и проверь на clvm».
Reconnaissance: the architecture review of the same day (identity/namespace hazards below are its findings).
Language policy: new substantive logic is stdlib-only Python (`src/tgcli/remote/`, launcher `tg-remote`,
no venv, no dependencies); TypeScript is glue that must live in the existing Bun runtime. No separate
divergent implementation: the Python port (tg-cli#768) will import the same `tgcli.remote` modules.

## 1. Problem

One bot, one Telegram chat, one poller (`tg-ctl` on Ubuntu). The owner's second host (`clvm`) runs its own
`tg` with the same bot token and agents of its own. Today:

1. A reply to a message sent from clvm reaches the Ubuntu daemon. No route exists for it, so it shows the
   picker or **auto-injects into the single live Ubuntu agent** (`agent-routes-reply.ts`, single-candidate
   branch) — possibly one whose pane id (`%3`) or pid equals the clvm sender's. Pane ids, pids and
   provisional keys (`cc:pane:<serverPid>/…`) are machine-local; never match a remote one against a local one.
2. clvm's routes/history exist only in clvm's own files. Ubuntu does not know the message.
3. `shouldAutoStart` (`features/tg-ctl/lock.ts`) is `Boolean(env.TMUX) && cfg.enabled`; one config omission on
   clvm starts a **second getUpdates poller**. The flock is per machine, not per token.
4. clvm's local outbox (tg-cli#710) is never replayed (no daemon).

## 2. Decision

The client machine knows its ctl server explicitly and talks to it itself; the daemon host knows which
machines it serves. Both directions already have working, key-authenticated SSH:

* **client → server** (clvm → Ubuntu): alias `tg-ctl-ubuntu` (provisioned: reverse tunnel, pinned host key,
  dedicated Ed25519 key). The Ubuntu `authorized_keys` line of that key (`restrict,from="127.0.0.1,::1",…`)
  forces `tg-remote server --peer clvm`. The peer name comes from that argv, never from the payload.
* **server → client** (Ubuntu → clvm): owner key; the daemon runs `tg-remote satellite serve` over SSH to
  deliver a reply into the sending machine's session.

Alternatives rejected: a bare unix-socket forward of the daemon socket (the daemon validates local
`ps`/cwd/pane against registrations, and `resolve-session` locators are machine-local, so a forwarder alone
cannot work and would invite misrouting); a new HTTP API (public ingress, new auth surface); hub-pull-only
journal (the sender would not know its server, nothing proves the link); `ssh ubuntu tg …` (loses local
attachments and session identity, replies would land on Ubuntu); tunnelling the daemon socket with a
synthetic session registry (topics/cards — phase 2, needs its own spec).

Direct Bot API sending stays on the client (it already holds the token; nothing is copied). What moves
to the server is **identity and routing state**: route + history per send, and reply delivery.

## 3. Configuration (`config.yaml`, `control:` block, flat scalars)

| Key | Host | Meaning |
|---|---|---|
| `control.server: ssh://tg-ctl-ubuntu` | client | Where the ctl runs. Regex `^ssh://[A-Za-z0-9][A-Za-z0-9._-]{0,62}$` — lowercase scheme, an `ssh_config` alias or host name only: no userinfo, port, path, query, leading `-`. Key, port, jump host and host-key pinning belong to `~/.ssh/config`. Presence = **client mode**. |
| `control.machine: clvm` | client | This machine's namespace in routes and history. Regex `^[a-z][a-z0-9-]{0,31}$`. Required when `control.server` is set. |
| `control.remote_machines: "clvm=ultra@65.21.40.51"` | daemon host | Comma list `name=ssh-target`: the peer allowlist AND the delivery address of replies. Target regex `^([A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$`, never starting with `-`; ≤ 8 entries; unique names. Absent/empty = feature off. |

Rules: `server`/`machine` together with `remote_machines` is an error (a machine is a client or the daemon
host). Any of the three keys present but invalid ⇒ every `tg` send (dry-run included), `tg-ctl
run|start|restart|enable|status` and `tg config validate` stop with the diagnostic and exit 78. Never a silent
fallback to local behaviour, never a second poller. All keys absent ⇒ behaviour is byte-identical to today
(no spawn, no file, no status line). Validation lives once, in Python
(`tg-remote config check [--json]`); TypeScript parses the raw strings (twin of `src/tgcli/tg_ctl/config.py`)
and calls it only when a key is present. `config.schema.json`, `docs/configuration.md` and `tg help config` are
generated (`bun run schema:gen`) with examples.

Client mode effects: `tg-ctl run|start|restart|enable` exit 78 `this machine is a ctl client of <server>; it
must not poll Telegram`; `shouldAutoStart` false; session topics are not used (post to General, no daemon
lookup, no anchor read, `resolve-session` never asked); the local outbox is not used
(`Telegram unreachable; client machines have no outbox replay — nothing queued, retry the send`, exit 1);
the header bracket becomes `[clvm/<window>]` and the history `targetAgent` uses the same string.

## 4. Wire protocol v1 (JSON lines, UTF-8, `ensure_ascii=False`)

One request line in, one reply line out, then the process exits. Request cap 1 MiB, reply cap 64 KiB, enforced
by reading at most cap+1 bytes. Replies: `{"ok":true,…}` or `{"ok":false,"code":"…","detail":"…"}`; codes
`BAD_REQUEST TOO_LARGE VERSION PEER_MISMATCH PEER_UNKNOWN BOT_MISMATCH MACHINE_MISMATCH NOT_CLIENT NO_DAEMON
UNSUPPORTED INTERNAL`. Unknown fields are rejected, not ignored.

### 4.1 Server endpoint (`tg-remote server --peer <name>`, forced command on the daemon host)

Ignores `SSH_ORIGINAL_COMMAND`. `peer` in argv must be in `control.remote_machines`, else `PEER_UNKNOWN`; a
payload `machine` ≠ argv peer ⇒ `PEER_MISMATCH`. Ops:

* `{"v":1,"op":"hello","machine":"clvm","bot":"<bot id>","client":"<version>"}` →
  `{"ok":true,"v":1,"peer":"clvm","bot":"<bot id>","version":"<version>","daemon":{"up":true|false},"caps":["record","status"]}`; `bot` differing ⇒ `BOT_MISMATCH`.
* `{"v":1,"op":"record","machine":"clvm","chat":"<chat id>","ids":[{"id":123,"threadId":null}],"route":{"paneId":"%3"|null,"cwd":"…","agentPid":1,"serverPid":2,"panePid":3,"sessionKey":"…","parentPaneId":"…"},"history":{"text":"…","targetAgent":"clvm/tg-cli","groupToken":"…","truncated":false},"name":{"primary":"tg-cli","secondary":"…"},"ts":1730100000000}` →
  `{"ok":true,"applied":true|false,"routes":N,"history":N}` (`applied:false` = duplicate of an applied `(chat,id)`).
  `history.text` is capped at 256 KiB UTF-8 by the client on a character boundary (`truncated:true`). The
  server forwards the validated record to the daemon hook socket as `{"kind":"remote-record","peer":"clvm","record":{…}}`; daemon down ⇒ `NO_DAEMON`.
* `{"v":1,"op":"status","machine":"clvm"}` → `{"ok":true,"peer":"clvm","daemon":{"up":true,"pid":N,"code":"<sha>"},"remote":{"records":N,"lastRecordAt":ms|null,"lastDeliver":{"at":ms,"result":"delivered|failed|uncertain"}|null}}`.

### 4.2 Satellite endpoint (`tg-remote satellite serve`, run on the client by the daemon host over SSH)

Requires client mode (`NOT_CLIENT` otherwise); payload `machine` must equal `control.machine`
(`MACHINE_MISMATCH`). Ops: `hello` (same shape as above, from the satellite) and
`{"v":1,"op":"deliver","machine":"clvm","idem":"<chat>:<message id>","route":{…as record…},"text":"…","replyTo":{"id":123}}`.
`deliver` first claims `<configDir>/remote/delivered/<chat>-<msg>.json` with `O_EXCL` and the state `claimed`
(fsynced). The marker is a ledger, not a receipt: after the sink returns it is rewritten atomically to
`delivered` or `uncertain` (never to `delivered` on a guess). A replay of an existing marker NEVER types again and
reports the ORIGINAL outcome: `{"ok":true,"duplicate":true,"outcome":"delivered"}` only when the stored state is
`delivered`; a stored `claimed` (crash between claim and sink result) or `uncertain` returns
`{"ok":false,"duplicate":true,"outcome":"uncertain","uncertain":true}`. So `ok:true` + `duplicate` can never hide an
undelivered message. Then it runs `tg-ctl satellite-deliver` (TS one-shot,
JSON on stdin) which resolves the target on **this** machine from `route.sessionKey`/`paneId` against live
sessions (the pane's cwd/pid must still match: a reused pane is refused) and uses the existing sinks
(`deliverOriginalOmp`, `injectInbound`/`buildTextInjectPlan`, host pane). Reply
`{"ok":true,"sink":"omp-live|tmux|host"}` or `{"ok":false,"error":"gone|unsubmitted|no-session|…","uncertain":true|false}`.
Inbound photos/documents to a remote route are refused with a chat notice (their paths are Ubuntu-local); text
and voice transcripts are delivered.

### 4.3 SSH invocation (Python builds argv as a list, never a shell string)

The protocol JSON is stdin of a process that must be our endpoint, never of a shell. Both directions therefore
pass an explicit, fixed command made only of constant words and one regex-validated machine name; a missing
launcher is the remote shell's `127`, never a login shell reading the JSON.

Client: `ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -- <alias> tg-remote server --peer <machine>`.
The configured key forces the pinned endpoint and ignores the requested command (authenticated peer = the key,
not the argv), but the command is still sent so an ordinary or misconfigured key can never feed a login shell.
Daemon host: `ssh -T -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 -o StrictHostKeyChecking=yes -- <target> tg-remote satellite serve`.
`StrictHostKeyChecking` is never `no`/`accept-new`; `--` precedes the host so a value can never become an option.
Every call runs in its own process group with a hard deadline (record 8 s, status/hello 6 s, deliver 15 s); on
timeout the group is killed. No automatic retry anywhere.

Python trust boundary: every Python process the TypeScript runtime starts for this feature is `python3 -I <launcher>`
(isolated: no cwd/script-dir on `sys.path`, `PYTHON*` variables and user site ignored); the launcher prepends only
its own `<repo>/src`. A planted `./tgcli/__init__.py` in the caller's cwd must never execute (tested). The forced
command on the daemon host pins absolute paths: `command="<abs python3> -I <abs install dir>/tg-remote server --peer clvm"`.

## 5. Flows

**Send (client).** unchanged local pipeline and direct Bot API post (attachments are read from clvm disk, `--dry-run`
file checks run on clvm) → `tg-remote client record` (stdin: record JSON): flush up to 5 older journal entries, then
one `record` within 8 s. Success: `recorded|duplicate`. Failure (SSH down, host key changed, daemon down, timeout):
the entry stays in `<configDir>/remote/journal/<chat>_<firstId>.json` (0700 dir, 0600 file, tmp+fsync+rename;
cap 500 entries; older than 24 h → `archive/` with a stderr warning, never dropped silently), `tg` prints a stderr
warning naming the server, the cause and the journal path, and exits 0 (the message is out; no resend).
`tg-remote client flush` replays the journal (apply is idempotent on `(chat,id)`).

**Apply (daemon).** `remote-record` upserts the SEPARATE store `tg-ctl.<bot>.remote-routes.json` (`{machine,chat,id,route,name,ts}`,
cap 300, locked read-modify-write like `routes.json`) and appends history rows with `pane="clvm/<paneId>"`,
`sessionKey="clvm/<key>"`, `targetAgent="clvm/<name>"`, `machine="clvm"`, deduped on `(chat,message,agent)`. `machine`
always comes from the authenticated peer. `routes.json`, `sessions.json`, `last-user-target.json` are never touched
and remote ids are never matched against local locators.

**Reply (daemon).** local `recognizeRoute` first (unchanged); on a miss, `recognizeRemoteRoute`; hit ⇒
`deliverInboundOnce(messageId, "machine:clvm/<key|pane>", send)` where `send` = `tg-remote hub deliver clvm`
(stdin: deliver JSON) → SSH → satellite. Failure ⇒ chat notice `clvm unreachable; tg#N not delivered`, ledger
`failed`; SSH dropped after the request was written ⇒ `uncertain` (final, owner notified, never re-sent). Never
`recordLastUserTarget`, never the local picker on remote failure. While `control.remote_machines` is non-empty an
**unrecognised** reply is never auto-injected into the single local candidate; the picker carries
`if this was for a clvm agent, its link may be down`. A reply whose anchor text begins with `[<known machine>/`
and has no recorded route gets the notice `route not recorded`, never a local delivery.

## 6. Operation routing (v1)

| Operation | Client machine |
|---|---|
| `tg` send (text, `--file`, `--photo`, `--table`, report, `--reply-to`) | local Bot API post; route+history recorded on the server |
| reply to a client-machine message | server → SSH → that machine's session |
| `tg-ctl status` | prints server, transport, hello round trip, journal depth, last record result |
| session topics, `tg --session-topic`, `/agent`, `/new`, `/status` across machines | **not supported** (client posts to General) |
| `tg-ctl ask`/cards/grants, `withdraw`, `alert`, `inbox`, `audit-delivery`, `harness-event` | **not supported**: stderr `ctl server <server>: <op> is not supported for remote clients`, exit 69 (an `ask` hook keeps today's no-daemon exit code and only adds the line, so a harness prompt is never turned into a deny) |
| inbound media to a remote route, headless `omp -p/--mode rpc` (no input channel) | refused with a chat notice |
| `tg replies`, `tg obligations`, msgref quotes | local client state only; history lives on the server |

## 7. Security

SSH keys are the only trust boundary; nothing listens on a port that was not already there. The forced command
`tg-remote server --peer clvm` takes no shell input; payload `machine`/`peer` never override argv; all
strings are validated against closed regexes before use; no value ever reaches a shell, an `ssh` option or a path
unchecked (journal and marker file names are built from validated `chat`/`id` integers). `restrict`
and `from=` stay on the key. Known open item (owner decision, not changed here): Ubuntu sshd still allows password
authentication, and the tunnel makes every clvm client a loopback client.

## 8. Test matrix

1 local compatibility (keys absent: same files, same spawns, `bun test ./tests`, `pytest tests/py` green) · 2 no
remote host = no change (no ssh spawn per tick, no `remote/` dir, no status block) · 3 bad config set (injection
`ssh://-oProxyCommand=x`, `ssh://u@h`, `ssh://h:22`, `ssh://h/x`, `SSH://h`, empty, both roles, missing machine,
duplicate/oversized `remote_machines`) → 78 · 4 client guards (`tg-ctl run|start|restart|enable` 78, autostart
false) · 5 SSH failure set (refused, timeout, host key changed, permission denied, remote exit 127, non-JSON,
oversized reply, hang → group killed, daemon down) → journal + warning + exit 0, hub side → notice + ledger · 6
partial reply (drop after write ⇒ `uncertain`, no second deliver; marker replay ⇒ `duplicate`) · 7 namespace (same
`%3`/pid on both machines; reply types only on clvm; `routes.json`/`sessions.json`/`last-user-target.json`
byte-identical; `tg replies` on Ubuntu pane does not show clvm rows; payload `machine:"ubuntu"` rejected) · 8
idempotency (same record twice = one route + one history group; flush replay; cap overflow archives) · 9 large
and Unicode (4096-split body, 256 KiB cap with `truncated`, astral emoji, RTL, combining marks, NUL rejected,
non-existent/oversized attachment path on the client) · 10 `--dry-run` offline (no ssh spawn/socket/journal) ·
11 forced-command hostile input (`SSH_ORIGINAL_COMMAND`, argv injection, unknown fields) · 12 unsupported-op
refusals · 13 `tg-ctl status` on both sides (real hello, not a fake line) · 14 satellite sinks (tmux pane, omp
live endpoint, gone session, reused pane refused) · 15 fake-API daemon integration (no live Telegram) · 16 live:
real SSH link, isolated loopback fake Telegram, read-only daemon status, negative dead-link run reports failure.

## 9. Plan (one branch `remote-ctl-20261028`, one PR, TDD red→green per item)

| Item | Owner | Files |
|---|---|---|
| T1 config keys + guards + schema/docs + Python config twin | ts-core | `features/tg-ctl/{types,config,lock}.ts`, `features/tg-ctl/remote-config.ts`, `daemon-runtime/cli-main.ts`, `features/config/schema.ts`, `config.schema.json`, `docs/configuration.md`, `src/tgcli/tg_ctl/config.py`, `tests/py/test_config_schema_parity.py` |
| T2 `tgcli.remote` + `tg-remote` launcher | py | `src/tgcli/remote/**`, `tg-remote`, `install.sh` (link), `pyproject.toml` (script), `tests/py/test_remote_*.py` |
| T3 client: recorder, header bracket, no topics/outbox, status, refusals, `--dry-run` | ts-client | `features/cli/outbound-runtime/**`, `features/tg-ctl/daemon-runtime/cli-main.ts` (status/refusals) |
| T4 hub: `remote-record`/`remote-status` socket ops, remote-routes store, reply branch, deliver sink, `satellite-deliver`, status block | ts-hub | `features/tg-ctl/remote-routes.ts`, `daemon-runtime/{remote-hub,satellite-deliver,hook-socket,agent-routes-reply,poll-loop*,status-command}.ts` |
| T5 integration, docs/CHANGELOG/version, AGENTS.md, full suite on the server, deploy | integrator | e2e tests with real `tg-remote` over a fake `ssh` shim |

Test seam: `TG_REMOTE_BIN` (path of the launcher; default `<repo>/tg-remote`) lets TypeScript tests substitute a
fake; `TG_REMOTE_SSH` overrides the `ssh` binary for Python tests. Neither is read from config.

## 10. Deployment (after merge)

`scripts/deploy.sh --checkout ~/.local/share/tg-cli` on Ubuntu (restarts the daemon); `install.sh` on clvm links
`tg-remote`; Ubuntu `authorized_keys` line `tg-ctl-clvm-20261028` is changed from the readiness `printf` to
`command="/home/ultra/.local/bin/tg-remote server --peer clvm"` (keeping `restrict,from=`); clvm config gains
`control.server`/`control.machine` only after `tg-remote doctor` passes; Ubuntu config gains
`control.remote_machines` and keeps its local daemon. AGENTS.md note about the systemd unit ("may be installed
but disabled") is corrected (`agenttools-tg-ctl-tg-ctl.service` is enabled).

## 11. Not supported in v1 (explicit)

Session topics and question cards for client-machine sessions (needs synthetic session entries that the scan-driven
registry would mark `gone`), `/agent`/`/new`/`/kill` across machines, non-reply Telegram messages routed to a
client, inbound media, headless jobs, outbox replay during a Telegram outage, two machines sharing a name, a
client on a different bot (refused by `hello`). Delivery is at-most-once and recorded; "exactly once" is claimed
only for the tested boundary (ledger claim before SSH, marker file on the client).
