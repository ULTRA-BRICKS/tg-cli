# Harness-agnostic control of wrapper-hosted sessions (tg-cli ↔ rig contract v1)

Status: SHIPPED in tg-cli 1.55.0 (the tg-ctl side). Owner: tg-cli. The rig side (the
`rig harness run` wrapper that writes the record) is specified here and implemented in rig-cli.
Authoritative: if rig-cli, agent-tools or a skill disagrees with this file, this file wins — fix
the other one.

Related: `docs/specs/2026-06-10-tg-ctl-control-design.md` (tmux control),
`docs/specs/session-registry-and-topics.md` (the session registry), `docs/omp-original-process.md`
(omp-live), the coordinator/subagent model in §6.

## 0. Model

A harness session (omp, Claude Code, Codex, opencode) is reachable by tg-ctl through the
**terminal that hosts it** — never through a second process that loads its history.

| Where the session runs | Address | Label (`[window]`) | Delivery |
|---|---|---|---|
| tmux pane | pane id `%N` | tmux window name (unchanged) | `tmux send-keys` / paste (unchanged) |
| omp, any terminal, with an omp-live endpoint | `omp:<pid>` | window name, else omp title | omp-live (receipts, busy queue) — first choice |
| abduco session hosted by the rig wrapper, no tmux pane showing it | `host:<name>` | record `label` | **abduco PTY injection** (§4) |
| none of the above | — | — | unreachable: listed and refused (§5) |

A tmux pane that shows a hosted session (an `abduco -a` client in the pane) wins: same session, the
pane's window name is the label, delivery is `send-keys` (tg-cli#454). omp keeps omp-live as its first
choice everywhere; the abduco PTY is its fallback only on a proven-absent endpoint
(`endpoint_unavailable`), exactly like the in-tmux own-pane fallback (#458). Any other omp-live error
still fails closed (the text may have been accepted).

## 1. Hosting requirements (wrapper side)

1. Process tree: `abduco server (reparented to pid 1) → [supervisor] → harness`. The supervisor
   (crash relaunch + resume) runs INSIDE the abduco session, so the PTY, the socket and any attached
   client survive a relaunch. Exactly one live harness process under the server at a time.
2. The harness's stdin/stdout/stderr ARE the abduco PTY slave (the supervisor inherits the fds; it
   never proxies or pipes the tty).
3. Neither the abduco argv nor the supervisor argv may contain the harness command. tg-ctl's matcher
   (`features/tg-ctl/discover.ts` `matchAgentCommand`) treats any argv containing `/claude ` or starting
   `claude ` as Claude Code (basename `omp`/`codex`/`opencode` likewise) and would take the abduco
   server or the supervisor for the agent. Pass the harness argv to the supervisor through its record,
   env or a file, e.g. `abduco -n <name> rig host-run <name>`.
4. Socket dir `ABDUCO_SOCKET_DIR=~/.local/state/rig/abduco` (rig's default). The record carries the
   ABSOLUTE socket path (the tg-ctl daemon runs under launchd with a different environment).
5. Session name `<harness>-<12 hex>`, matching `[A-Za-z0-9][A-Za-z0-9_.-]{0,60}`; stable across
   relaunches (it is the delivery address).

## 2. Env the wrapper exports into the harness

- `RIG_SESSION=<name>` — every harness. `tg` uses it outside tmux to find the record (label for the
  `[window]` bracket) and to stamp its outbound route with origin `host:<name>` so a CTO reply routes
  back. It REPLACES `RIG_OMP_SESSION` (clean cutover; an omp started before the cutover is still
  located by its abduco ancestry).
- Role (§6): export NO positive coordinator marker; scrub `RIG_AGENT_ID RIG_DETACHED_AGENT
  PI_SESSION_FILE TG_AGENT` before exec. The record is always `role: "coordinator"`.
- Known hazard: the abduco server inherits the environment of the client that created the session,
  including a stale `TMUX`/`TMUX_PANE`. `tg` trusts `$TMUX_PANE` first (unchanged); the wrapper SHOULD
  `unset TMUX TMUX_PANE` before exec so a session started from a tmux pane and later attached elsewhere
  is not named after a pane id that was reused.

## 3. Registration record (wrapper writes, tg-ctl only reads)

Dir `${TG_CTL_CONFIG_DIR:-$HOME/.config/tg-cli}/hosts/` (0700). One file per abduco session,
`<name>.json`, 0600, written atomically (temp file in the same dir + rename). Written when the
supervisor starts, rewritten on every relaunch and label change, DELETED on a user-requested exit (or
when the crash-loop cap gives up). tg-ctl never writes or deletes it.

```json
{
  "v": 1,
  "name": "claude-3f9a0c1d2e4b",
  "harness": "claude",
  "label": "tg-cli",
  "cwd": "/Users/ultra/xp/tg-cli",
  "socket": "/Users/ultra/.local/state/rig/abduco/abduco/ultra/claude-3f9a0c1d2e4b@Ultras-MBP.local",
  "serverPid": 12345,
  "harnessPid": 12400,
  "role": "coordinator",
  "startedAt": "2026-09-30T21:30:00Z",
  "updatedAt": "2026-09-30T21:30:00Z"
}
```

- `name`: abduco session name == file stem. `harness`: `omp | claude | codex | opencode`.
- `label`: the human name → the `[window]` bracket outside tmux. Optional; trimmed, at most 64 characters.
  Fallback: the harness title, then the cwd basename.
- `serverPid`: the abduco server pid (a supervisor inside abduco: `getppid()`).
- `harnessPid`: informational. tg-ctl re-derives the live harness pid from the server's process tree on
  every scan, so a stale value after a relaunch is harmless.
- `role`: `"coordinator"` (REQUIRED). A record with any other role is skipped — subagents are never
  delivery targets.
- Unknown extra fields are ignored (rig may add `resume`, `restarts`, `supervisorPid`, …).

Validation (`features/tg-ctl/host-registry.ts` `parseHostRecord`): a regular file, not a symlink, owned
by the daemon's uid; `v === 1`; `name` equals the file stem and matches the id regex; `harness` known;
`role === "coordinator"`; `socket` absolute with basename `name` or `name@<host>`; `serverPid` a positive
integer. A bad record is skipped and logged once, never fatal.

Liveness (`liveHosts`), re-checked on every scan and again right before a write: the process at
`serverPid` is the abduco server of exactly this session (`abducoSessionName(argv) === name`), the
socket exists, and exactly ONE agent process of the recorded harness kind sits at the shallowest depth
below the server. A dead/reused pid, a missing socket, no harness (mid-relaunch) or two at the same
depth make the record not-live: it is skipped, never guessed around. A harness the harness launched
(`claude -p` from claude) is deeper and ignored.

## 4. Delivery

Target id of a non-tmux hosted session: `host:<name>`; every inbound goes through
`deliverInboundOnce` with ledger target `host:<name>` (exactly once, #517/#299).

`features/tg-ctl/abduco-pty.ts` speaks abduco 0.6's client protocol (verified 2026-09-30 on the brew
build): 16-byte header (u32 type @0, u64 payload length @8, native/little-endian) then the payload.
`MSG_ATTACH` with flags `2` (low priority: never steals the session from a human attached elsewhere),
`MSG_CONTENT` packets of at most 1024 bytes (Darwin BUFSIZ), `MSG_DETACH`. The client discards the screen
output the server streams to it.

Bytes (the tmux recipe): a one-line message is typed as is (like `send-keys -l`; Tab becomes a space,
it would trigger completion); a multi-line message is ONE bracketed paste `ESC[200~ … ESC[201~` (a typed
newline would submit early). Paste markers are sent only for multi-line text: the wire cannot know whether
the harness enabled bracketed-paste mode, and one that did not would show them literally. Then a 500 ms
gap and a SEPARATE `\r` (an Ink TUI drops an Enter glued to the text). The text is sanitized first:
CR/CRLF → LF, every other C0 control character (above all ESC, which could end the paste early and turn
the tail into keystrokes) and DEL dropped; a message with nothing typeable left is refused unsent.
The unix socket path must fit `sun_path` (104 bytes on Darwin); rig's default dir does.

Failure semantics: nothing was written (cannot connect, attach refused) → `failed`, a retry is safe.
Connection lost AFTER content bytes were written → ledger `uncertain`: the text may sit in the prompt, so
the message is never re-sent and the CTO is told to check. Delivery counts as done when the Enter was
written; a failing final detach changes nothing.

Routing: a `host:<name>` session is an `/agent` candidate (selector: label, session name, unique cwd
basename), a reply target (the route origin `tg` stamped), the sole-candidate auto-bind when no tmux
pane hosts an agent, and a picker row. It is not a forum-topic target yet (no session-registry entry).

### 4.1 Native question / permission cards (tg-cli#544, #535)

`tg-ctl ask` (the installed Claude Code / Codex hook) scopes its request to the session that asked:
`$TMUX_PANE` first (unchanged); outside tmux, `host:<name>` — the record `$RIG_SESSION` names, used only
when that host is live (§3) AND the hook process runs under its abduco server (`hostOfPid`). The
variable alone proves nothing: it is inherited by everything started from the session. Otherwise the
request stays unscoped, as before.

The daemon believes a `host:<name>` scope only while the registry proves that host live right now
(any client can send a paneId); a scope it cannot prove is dropped (`ask-forward host-unverified`) and
the ask continues unscoped. A verified host is its session's registration: no `tg`-written
registration is needed (`tg` auto-registers only inside tmux).

A scoped hosted question defers inbound for `host:<name>` only, like a pane-scoped one — other
sessions are typed into as usual. Once its hook is gone, everything goes through `deliverToHost`:
a late tap on a question card types the chosen label (claimed first, so once), a text reply to the
card types the reply (ledger, once per message), a hatch grant/deny notice types the notice. A
connection lost after bytes were written is reported in the chat, never re-sent. A late PERMISSION
tap is queued for the reconnecting hook: a host has no pane to capture, so its menu cannot be
re-verified before a digit is typed (tg-cli#576). Known gap: a tmux pane that shows the session
(`abduco -a`) is a second address the host-scoped question does not hold (tg-cli#575).

## 5. Unmanaged sessions

A harness in no tmux pane and no live host record stays unreachable: `tg-ctl status` lists it, `/agent`
to it gets the refusal, nothing is queued. Text:
"not reachable — started outside tmux and outside the rig wrapper; restart it with
`rig harness run <harness> --name <label>` (or in a tmux window: `tmux new-window -n <label> <harness>`)".
omp outside tmux without an endpoint and without a host stays fail-closed (no spawn fallback).

## 6. Coordinator vs subagent

Only coordinators register and receive inbound delivery. There is no positive coordinator env marker
(env is inherited by children); `role: "coordinator"` in the record is the wrapper's statement that it
hosts the top-level TUI. The per-harness subagent signals, and the one place each consumer computes
role, are in the role model (agent-tools `lib/agenttools_agent_role`, tg-cli `features/agent-role/`).
tg-ctl never guesses a role from env, pane, cwd or process tree.

## 7. Audit

`tg-ctl audit-delivery` reports a `host:<name>` delivery like any other: delivered / not delivered /
duplicated from the ledger record, with the harness transcript as a second witness where one exists.
