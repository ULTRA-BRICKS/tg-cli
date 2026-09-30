# Original-process OMP transport

`tg-ctl` controls a live OMP through a local extension hosted by that exact process.
`omp acp` with `session/load` opens a separate history writer; it is not live attach.
Neither replies nor reminders may use that old path, even when the bridge is missing.

## Install and inspect

Run `tg-ctl omp-live install`; the `tg-ctl` daemon also installs it idempotently at startup
whenever `~/.omp/agent` exists. New interactive sessions load the extension automatically.
For an already-running OMP, save its exact session, stop that original, then resume it once
(prefer `rig omp run` for durable terminal ownership). Never resume while the original is
still alive. Verified OMP 18.3 `/reload` reloads plugins/MCP, not new JS extension modules,
and OMP imports each extension module once per process (subagents rebind the same factory
without re-evaluating it), so a running OMP keeps its old extension code until that
saved stop/resume. The installer preserves
unmanaged extension files and refuses a conflicting installation instead of overwriting it.
`tg-ctl omp-live status --json` returns an array of probed original processes with
`pid`, `instanceId`, `sessionId`, `sessionFile`, `cwd`, `durableSession`, `busy`, and `title`.
There are no bot credentials or capability tokens in that output. A host that accepts the
status connection but does not answer within 1 s (its event loop is busy in a long step) is
still listed, from its private metadata, with `busy: true`; it is never reported as gone. A
send to such a host that times out says the text may still arrive once it frees up; it is
never retried through another path.
`tg-ctl status` lists every live OMP with its bridge state and names each one WITHOUT a
bridge (`omp without bridge: N`) together with how it is reached meanwhile. When it can read
the process start (`ps -o etime=`), each such line also says whether the OMP started before
the installed bridge code last changed (it still runs the older bridge: save/stop + resume
once) or after it (a real bridge failure: check `~/.omp/logs/omp.<date>.<pid>.log`).

For a local verified delivery use:

```sh
tg-ctl omp-live send 12345 --request-id manual-unique-001 --session EXACT_SESSION_ID 'text'
```

The receipt means **accepted/queued in the original process**, not read by the model,
not completed, and not successful execution of the requested task. A model response or
independent artifact check is still needed for those claims. Busy inputs use OMP's own `followUp` queue; idle inputs use `aside` to start a turn
without interrupting a concurrent turn that wins the admission race. Native permission and question hooks remain the approval channel.

## Endpoint ownership (#462) and self-heal (#458)

One OMP process hosts one interactive TUI session but many extension bindings: OMP 18.3
binds the same prepared factory again for every in-process task subagent. Only a binding
whose context is the original interactive session (`hasUI`, TUI mode, no agent id) claims
the process-wide endpoint slot. A subagent's bind, `session_start`, turns and
`session_shutdown` never close or withdraw the TUI session's endpoint; the TUI session's own
`session_shutdown` still removes it. A newer binding of the same TUI session (a reload)
replaces the older one, and the stale binding never re-claims it.

At every `turn_end` and `agent_end` the owner checks that its metadata and socket are still
registered and republishes when they are missing (registry wiped, pruned, or a failed
startup publish). A failed publish warns once per outage, not once per turn.

## Missing endpoint: in tmux vs outside tmux (#458)

An OMP running in a tmux pane with NO endpoint (started before the extension was installed,
or still on the old extension) is reached by `tmux send-keys` into that same pane: the
original TUI's own input box, the same keystrokes a human would type. That is not a second
history writer and never spawns or resumes anything. The fallback runs only when the
endpoint is proven absent (`endpoint_unavailable`: nothing registered or listening for that
exact PID, nothing sent) and the pane still hosts exactly that PID. A timeout, dropped
connection, stale identity or any other endpoint error fails closed, because the text may
already have reached the host; typing it again would duplicate it. The same
defer-while-waiting rule as every tmux pane applies: text is queued, never typed, while the
pane has an open forwarded question. An OMP outside tmux without an endpoint still fails
closed with the install/restart hint. Claude Code and Codex remain tmux-only.

## Identity and safety

The registry is `${TG_CTL_CONFIG_DIR:-~/.config/tg-cli}/omp-live` (0700). Metadata and
Unix sockets are 0600, owned by the same OS user; symlinks, insecure modes and stale
identities are refused. Each process publication has a random instance ID and token.
A request binds PID, instance and session. A missing PID does not retarget by cwd or name.
A session-only grant target is allowed only when exactly one verified original publishes
that session. Selecting an agent by a human-readable label still uses the existing ambiguity
picker; the selected process then has to satisfy the exact socket identity check.

Retries of the same request ID and content reuse the original receipt. Conflicting content
is rejected. Telegram inbound message IDs are passed explicitly, including unwrapped input.
The receipt store is bounded to 4096 entries per endpoint lifetime; saturation fails closed
instead of evicting old receipts and accidentally replaying work. Restart/reload creates a
new endpoint generation: it does not claim durable exactly-once delivery across that boundary.
Authentication tokens are local capabilities and are never logged or sent to Telegram.

On macOS and Linux this uses Unix sockets. Windows named-pipe support is not implemented;
unsupported hosts fail explicitly rather than falling back to history cloning. Likewise,
an original outside tmux started without the extension requires install and a saved
restart; it is never replaced.

## Regression coverage migration

The removed ACP-client implementation had tests for spawning/loading children, its private
prompt queue, and timed eviction into a replacement child. Those implementation assertions
are intentionally retired. Their safety scenarios now run against original sockets in
`ctl-omp-live-{order,error,busy,no-takeover,id-conflict}.test.ts` and the Node runtime/extension
tests. Existing daemon-level tests retain text replies, selection buttons, route anchors,
headless discovery, durable inbound batch replay, and late-grant delivery. The additional
`ctl-omp-live-original-integration.test.ts` asserts a real daemon never invokes a trap `omp`
executable, with or without an available original endpoint. Pure legacy ACP codecs remain
covered for compatibility with saved old cards; they do not authorize any production spawn.
`omp-live-extension.test.mjs` covers the #462 subagent bind/start/shutdown regression and
turn-boundary self-heal; `ctl-omp-tmux-fallback-integration.test.ts` runs the real daemon
against an in-tmux OMP with and without an endpoint, plus the `tg-ctl status` bridge list.
