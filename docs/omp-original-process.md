# Original-process OMP transport

`tg-ctl` controls a live OMP through a local extension hosted by that exact process.
`omp acp` with `session/load` opens a separate history writer; it is not live attach.
Neither replies nor reminders may use that old path, even when the bridge is missing.

## Install and inspect

Run `tg-ctl omp-live install`. New interactive sessions load the extension automatically.
For an already-running OMP, save its exact session, stop that original, then resume it once
(prefer `rig omp run` for durable terminal ownership). Never resume while the original is
still alive. Verified OMP 18.3 `/reload` reloads plugins/MCP, not new JS extension modules. The installer preserves
unmanaged extension files and refuses a conflicting installation instead of overwriting it.
`tg-ctl omp-live status --json` returns an array of probed original processes with
`pid`, `instanceId`, `sessionId`, `sessionFile`, `cwd`, `durableSession`, `busy`, and `title`.
There are no bot credentials or capability tokens in that output.

For a local verified delivery use:

```sh
tg-ctl omp-live send 12345 --request-id manual-unique-001 --session EXACT_SESSION_ID 'text'
```

The receipt means **accepted/queued in the original process**, not read by the model,
not completed, and not successful execution of the requested task. A model response or
independent artifact check is still needed for those claims. Busy inputs use OMP's own `followUp` queue; idle inputs use `aside` to start a turn
without interrupting a concurrent turn that wins the admission race. Native permission and question hooks remain the approval channel.

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
an original started without the extension requires install/reload; it is never replaced.

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
