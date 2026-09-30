# Coordinator vs subagent — the single role model

Status: AGREED (2026-09-30). Code: `features/agent-role/role.ts`; tests: `tests/agent-role.test.ts`
(per-harness fixtures in `tests/fixtures/agent-role/`), `tests/cli-agent-send.test.ts` (real `tg`
binary), `tests/omp-live-extension.test.mjs` (endpoint ownership). The same rule lives in
agent-tools as `lib/agenttools_agent_role`, shared by the four hook bridges.

## 1. Definitions

- **Coordinator** — the top-level, human-facing agent of one harness session: the interactive
  TUI the CTO talks to (tmux pane or rig abduco wrapper). One per registered session.
- **Subagent** — any agent run DISPATCHED by another agent:
  - in-process native subagents: omp `task` subagents, Claude Code Task/Agent subagents,
    Codex `spawn_agent` threads (+ review/guardian threads), opencode `task` child sessions;
  - detached children: a separate headless harness process an agent launched (`claude -p`,
    `omp -p`, `codex exec`, `opencode run`, rig-detached-* launchers, review-cli reviewers).
- Role belongs to the **agent run** (thread/session), NOT to the process, pane, cwd or env.
  In-process subagents share the pid, the tmux pane, the cwd AND (cc/codex) the `session_id`
  with their coordinator.

## 2. The rule

    role = subagent    iff a TRUSTED subagent signal is present (§3)
    role = coordinator otherwise — but only a wrapper-registered session (or a tmux pane)
                       is ever a DELIVERY target / endpoint owner.

There is deliberately NO positive "I am the coordinator" env marker: env is inherited by every
child, so a coordinator marker would leak into its own `claude -p` / `omp -p` children and label
them coordinators (the mirror image of the `CLAUDE_CODE_CHILD_SESSION` bug).

A signal is TRUSTED only if the harness or the launcher sets it and the model cannot forge it:
hook-payload top-level fields written by the harness, harness extension/plugin context,
harness-managed env (omp clears it on the main session), or launcher env set on the CHILD at
exec. Anything inside `tool_input` / tool args is model-controlled and ignored.

## 3. Per-harness signals (verified 2026-09-30)

| Harness | Hooks (tool-call time) | Bash env of the agent (e.g. `tg`) | Evidence |
|---|---|---|---|
| Claude Code 2.1.285 | top-level `agent_id` (+`agent_type`) present ONLY inside a Task/Agent subagent; absent on the main thread. `session_id`/`transcript_path` are the SAME for both. | IDENTICAL for main vs subagent → cannot tell; explicit `--subagent`/`TG_AGENT` required | live capture `claude -p` + Agent tool (`claude-code-2.1.285-*` fixtures) |
| Codex 0.153.4 | top-level `agent_id`/`agent_type` (optional in PreToolUse/PermissionRequest schema, required in SubagentStart/Stop). "Subagent hooks use the parent session id" → `session_id` cannot tell. A spawned thread's OWN rollout has `thread_source=="subagent"` (guardian review: `guardian_review`) + `parent_thread_id`; the hook `agent_id` is that rollout's `id`. | no per-thread env → explicit label | schema from the 0.153.4 binary + recorded rollouts; **live hook capture blocked** (Codex usage limit) — ticket |
| omp (fork) | extension ctx: `ctx.getAgentId()` non-empty ⇒ subagent; endpoint owner = `hasUI && mode=='tui' && !getAgentId()`; the agent-tools bridge also trusts a nested `sessionFile` (`…/<session-id>/<agent>.jsonl`) and payload `isMainSession===false` | omp sets `RIG_AGENT_ID=<agent>` + nested `PI_SESSION_FILE` on a subagent's bash and `unset -v`s both on the MAIN session's bash (anti-forgery) | live: subagent bash has `RIG_AGENT_ID` + nested `PI_SESSION_FILE` (`omp-bash-env.json`) |
| opencode 1.18.30 | subagent = child session: `session.parentID != null` (the bridge plugin resolves it from `input.sessionID` via the plugin client) | same process → explicit label | recorded opencode.db: 112 of 11169 sessions have `parent_id` (titles "(@explore subagent)") |
| any detached child | launcher env on the child: `RIG_AGENT_ID=<name>` or `RIG_DETACHED_AGENT=1` | inherited into bash (cc/codex/opencode). An `omp -p` child's main session unsets it → gap (ticket) | agent-tools `launcher_agent_id` contract (#476/#573) |

### Rejected (NOT role signals)

- `CLAUDE_CODE_CHILD_SESSION` — live: `=1` on the MAIN thread of `claude -p` too; main vs
  subagent Bash env identical. The old `features/agent-detect/` auto-detection is deleted.
- `CLAUDECODE` / `AI_AGENT` / `CLAUDE_CODE_ENTRYPOINT` — harness identity, not role (omp
  exports `CLAUDECODE=1` as well).
- `session_id`, `transcript_path` (cc/codex hooks carry the parent's), tmux pane / `TMUX_PANE`,
  cwd, window/title, pid/process tree for in-process subagents, `RIG_OMP_SESSION` /
  `RIG_SESSION` (session MEMBERSHIP, inherited by every subagent).
- Any identity field inside `tool_input` / tool args (model-controlled; bridges strip it,
  `hookPayloadRole` reads top-level fields only).

## 4. Where role is computed (one place per consumer)

1. **agent-tools hooks** — each harness bridge sets the trusted `args.agent_id` (cc/codex:
   top-level `agent_id`; omp: ctx / nested sessionFile / `isMainSession`; opencode: plugin-
   resolved `parentID`; all: `RIG_AGENT_ID` / `RIG_DETACHED_AGENT`) through
   `agenttools_agent_role`. No per-bridge copies.
2. **`tg-ctl ask` (hook-normalize)** — `ButtonRequest.subagent` = the raw payload's top-level
   `agent_id`/`agent_type` (`hookPayloadRole`, label `<type>#<last 8 id chars>` — the random tail,
   since Codex's UUIDv7 heads repeat for ~65 s), else the hook process env
   (`envRole`: `TG_AGENT` > `RIG_AGENT_ID` > `RIG_DETACHED_AGENT=1`). The opencode adapter takes the
   fetched session record (`opencodeSessionRole(session)`); the daemon has no opencode SSE
   subscriber yet (tg-cli#533), so that path is adapter-only.
3. **`tg` outbound `[subagent]` bracket** — `senderRole`: `--subagent` > `TG_AGENT` >
   `RIG_AGENT_ID` > `RIG_DETACHED_AGENT=1` (→ `detached`). The coordinator passes nothing → no
   bracket. cc/codex/opencode IN-PROCESS subagents MUST pass `--subagent` (no trusted env).
4. **omp-live endpoint ownership** — only the binding with `hasUI && mode=='tui' &&
   !ctx.getAgentId()` claims/closes/withdraws the endpoint (#462). Subagent bindings never
   (`omp-live-extension.mjs`, pinned by `omp-live-extension.test.mjs`).
5. **Registration / direct delivery** — ONLY coordinators register and receive inbound Telegram
   delivery. A registration carries `role: "coordinator"`; subagents are never delivery targets
   (inbound for a gone subagent goes to its coordinator anchor).
6. **rig guardrails** (`orchestrator-stays-thin`, `background-subagent-gate`, …) gate only
   role=coordinator; subagent-only hooks fire only on role=subagent.

## 5. Wrapper env contract

- The coordinator wrapper exports session MEMBERSHIP only: `RIG_SESSION=<abduco-name>`
  (harness aliases like `RIG_OMP_SESSION` allowed) — membership, NOT role.
- It MUST scrub subagent markers before exec: `unset RIG_AGENT_ID RIG_DETACHED_AGENT
  PI_SESSION_FILE TG_AGENT` (a wrapper launched from inside a subagent's shell would otherwise
  start a "coordinator" every consumer treats as a subagent).
- It MUST NOT export any positive coordinator marker (`AGENT_ROLE=coordinator` etc.).
- Detached launchers set `RIG_AGENT_ID=<name>` (or `RIG_DETACHED_AGENT=1`) on the child and
  never register it as a delivery target.

## 6. Known gaps (tracked as tickets)

- Codex live hook capture: the `agent_id` field is schema-proven and rollout-consistent but
  unobserved on a live hook (usage limit).
- An `omp -p` child's MAIN session unsets `RIG_AGENT_ID`, so a detached omp child looks like a
  coordinator to `tg` and to env-reading gates.
- In-process cc/codex/opencode subagents have no trusted env: their `tg` calls are unlabelled
  unless the dispatcher passes `--subagent`.
