# tg-cli roadmap

Snapshot: **2026-09-29**. This file is the source of truth for tg-cli priorities. The tg section of
`agent-tools/ROADMAP.md` (frozen at 2026-08-15, claims topics "all CLOSED") is superseded by this file.
Tracker: https://git.hyperide.ai/ultrabricks/tg-cli/issues — milestones M0–M5 are epics with labels
`epic` + `milestone:Mx`; M6 is a `milestone:M6` label only. Every groomed issue carries
`grooming:2026-09-29` plus a `milestone:Mx` label or a closing disposition.

## Why this order

The CTO, 2026-09-29 (verbatim):

> Вклдчил в тг боте топики! Но они пока не работают
>
> Но ладно топики у нас до сих пор пиздец как много проблем с базовыми функциями.
>
> до работы с топикам надо чтобы сессии из tmux подтягивались, когда они в tmux. А если есть ещё и
> название сессии в самом харнесе его тоже надо показывать. Но основное из tmux. Если запущено не в
> тмукс то название сессии из тайтла харнеса тогда и если происходят переименования их надо
> подхватывать а не создавать новые сессии в тг (чтобы не плодилис топики, когда мы их починим)
>
> Надо чтобы omp работал как в tmux так и вне его. cc, codex только в tmux

Standing decision, tg#16810 (2026-09-10): «нельзя зашивать в TG никакие конкретные Harness все должно
быть универсально и через адаптеры … За работу с харнесами должен отвечать harness-cli».

So: **identity → delivery → questions → topics → noise**, with a live-verification baseline first,
because the dominant failure over the last year is "the fix merged, then failed live".

## What is broken today (evidence, 2026-09-29)

- **Identity.** A "session" is keyed by a locator (tmux pane id or `omp:<pid>`), never by the harness
  session id. Six separate code paths derive a display name. omp running under `abduco` (rig
  `omp run`, panes %0–%4) is invisible to pane discovery: 14 false "agent is no longer running"
  pickers, `agent-panes=0` logged 16,597 times (09-12..09-27), "Claude Code not in tmux" sent for an
  omp session that is in tmux. An omp restart/resume changes the pid and becomes a new entity. The
  `/agent` picker replaces the tmux window name with the omp title; `tg` prints a literal `[no tmux]`.
  A tmux rename splits `tg replies` history into two agents.
- **Delivery.** Only 3 of 12 live omp processes expose an omp-live endpoint; omp without one fails
  closed even inside tmux, and endpoints disappear while the process lives (#462). One Telegram
  message was injected 7× into one session (09-21). The CTO re-sent 22 messages within 48 h because
  the first did not arrive. 17 messages to non-tmux cc/codex sit undelivered in the Stop-hook inbox
  since 09-18.
- **Topics.** Threaded mode is on (`getMe.has_topics_enabled=true`, chat = private DM) but zero topic
  bindings exist. The design treats "topic created" as "spawn a new agent" (path → model →
  `tmux new-window`); no existing session is ever mapped to a topic; user-created topics start that
  wizard and swallow the text; an unknown topic silently drops every message; bound topics drop
  voice/media and can't reach omp; a topic rename overwrites the tmux window name.
- **Process.** 206 open issues (59 reopened on 2026-09-24 for missing acceptance proof); ~5k lines of
  uncommitted work in 9 worktrees; the daemon is not restarted after a merge (#279), so merged fixes
  don't run.

## Target harness matrix

| Harness | In tmux | Outside tmux | Identity key | Display name | Delivery |
|---|---|---|---|---|---|
| omp | yes | yes | `sessionId` / `sessionFile` | tmux window · omp title; outside tmux: omp title | omp-live extension; in tmux without an endpoint: tmux send-keys into the same TUI |
| Claude Code | yes | no — clear "run it in tmux" reply | `session_id` + pane | tmux window · cc title | tmux send-keys |
| codex | yes | no — clear "run it in tmux" reply | thread id + pane | tmux window · codex title | tmux send-keys |

## Architecture direction

- **harness-cli owns per-harness adapters** (tg#16810): list live sessions as
  `{harness, sessionId, pid, tmuxPane, windowName, harnessTitle, cwd}`, deliver text, detect a pending
  prompt. tg-ctl consumes that API and owns the harness-neutral parts: session registry, naming
  precedence, routing, questions, topics.
- **Registry key = harness session id.** pid and pane are locators re-resolved on every scan; a rename
  or restart updates the same entry. Nothing (routes, history, registrations, topics) keys on a name or
  a pid.
- **One name resolver** `{primary: tmux window, secondary: harness title}` used by the `tg` header, the
  `/agent` picker, `tg-ctl status`, `tg replies` and topic names. Harness title comes from tmux
  `#{pane_title}` (omp sets `π > <title>` via OSC, also under abduco) or from the adapter.
- **Topics are strict**: a topic message goes to its bound session or fails visibly — never to
  last-user-target or a cwd guess.

### Why omp-telegram exists, and what we take from it

`omp-telegram` (npm 0.14.0, github.com/TerrifiedBug/omp-telegram) is a third-party omp **extension**.
omp's API for a live TUI is in-process only (`pi.sendUserMessage`, `getSessionName`, session events);
`omp --mode rpc` and `omp acp` spawn their own process, and ACP `session/load` on a live session is a
second history writer. So any bridge into a running omp must run inside omp — the same reason tg-cli
#450 ships the `tg-omp-live` extension. We do **not** install it: it polls `getUpdates` itself (a 409
fight with tg-ctl), is omp-only, herdr-coupled and has no tmux/cc/codex. We borrow:
session identity `sessionFile > sessionId` with pid as liveness only; one topic claimed per top-level
session and re-adopted on resume; fail-closed topic routing with acknowledged, durable handoff; a
topics doctor. We add what it lacks: tmux-primary names, `editForumTopic` on rename, cc/codex.

## Milestones

Definition of done for every ticket: merged **and** deployed (daemon restarted) **and** proven live by
a qa-cli Telegram e2e run or an equivalent recorded live proof. Merged-but-unverified tickets carry
`verify-live`; shipped-with-evidence ones carry `ready-for-acceptance`.

### M0 — Truth & live-verification baseline · epic #472

Goal: a fix counts only when it runs live. Exit: qa-cli e2e drives the real bot against fixture
sessions; merge → deploy → daemon restart is automatic; no work rots uncommitted.

- **P0** #279 daemon never restarts after a merge, so shipped fixes don't run
- #468 qa-cli headless Telegram e2e harness (fixtures: omp in/out of tmux, cc, codex)
- #470 rescue or drop ~5k uncommitted lines in 9 worktrees; remove 19 merged leftovers
- #469 docs/status drift (launchd label, "omp — ACP", dead ACP helpers)
- #442 Forgejo migration sub-epic (#440 → PR #453; #410)
- test/CI health: #82 #143 #154 #326 #375 #401; docs #32 #277

### M1 — Session identity & naming · epic #473 (prerequisite for topics)

Goal: every session has one stable identity and one name everywhere. Exit: rename a tmux window or
`/rename` an omp session → header, picker, status, history and (later) topic follow in place; restart /
resume keeps the identity; abduco-wrapped omp is a tmux session.

Design: `docs/specs/session-registry-and-topics.md` (registry, naming, topics; slices S0–S9).

- **P0** #454 abduco-wrapped omp treated as not-in-tmux (false "no longer running", "Claude Code not in tmux")
- **P0** #455 picker/status overwrite the tmux name with the omp title; `[no tmux]` literal
- **P0** #75 name resolver keeper (tmux window primary · harness title secondary)
- #487 (new, 2026-09-30) session registry store keyed by harness session id + migration (spec §2)
- #459 omp routes keyed by pid → key by sessionId/sessionFile
- #460 `tg replies` history keyed by name → session id; tag non-tmux omp sends (recorded today but untagged) (+ #136 lock)
- #354 pane-id reuse after tmux restart (PR #351); #100 verify pane identity before late delivery
- #67 registration set → session registry; #263 #264 #265 labels/identity in harness events and limit-continue
- #446 #448 header follow-ups from PR #447 (verify-live)

### M2 — Inbound delivery basics · epic #474

Goal: every accepted Telegram message reaches exactly the intended live session exactly once, or the
CTO sees an explicit failure. Harness matrix above.

- **P0** #339 replies miss live omp outside tmux
- **P0** #458 omp-live coverage 3/12 → auto-install, self-heal endpoints, tmux fallback in tmux
- **P0** #299 lost/duplicate inbound (22 re-sends; one message injected 7×) — exactly-once + audit
- **P0** #462 an in-process omp subagent spawn withdraws the main session's omp-live endpoint
- #456 cc/codex outside tmux → clear "run it in tmux" reply; retire the inbox path
- #463 typed into the pane but never submitted; #461 empty reply previews
- routing: #53 #78 #272 #274 #419 #422; #280 albums split; #190 #415 `!shell`
- daemon: #438 stop/restart liveness; #357 #360 delivery isolation / exactly-once; #183 downtime replay
- #377 harness-cli migration sub-epic (routes and prompts behind harness-cli adapters, tg#16810)

### M3 — Questions, permissions, hatch approvals · epic #475

Goal: a tap always does something visible; a pending question stays open until it is really resolved.

- **P0** #403 critical hatch approvals ("Approve в хетчах так и не нажимаются")
- **P0** #304 pending-prompt detection per harness (evidence sits uncommitted, rescue via #470)
- #464 remind about unanswered questions (new)
- late delivery / persistence: #57 #58 #99 #233 #283 #268 #309 #317
- hatch: #356 `tg hatches`, #402 card design, #433 grant protocol, #327 photo hatch
- design decisions pending: #127 defer queue vs "no queue", #149 / PR #368 block-and-wait, #373 #374
- #97 #118 #203 #211 #212 #231

### M4 — Forum topics: one topic per existing session · epic #476

Starts after M1 + M2 exit. Goal: every live session has exactly one bot-created topic, named by the M1
resolver, renamed in place, never duplicated.

Design: `docs/specs/session-registry-and-topics.md` §4.

- **P0** #457 user-created/implicit topics start the spawn wizard and swallow text; unknown topic = black hole
- #467 one bot-created topic per session; outbound + question cards threaded into it (no env)
- #465 bound topics drop voice/media and can't reach omp
- #466 rename sync: harness/tmux rename → `editForumTopic`; never topic → tmux
- `/new` in a topic: #27 #185 #186 #150; #52 #56 #181 #298 (verify-live / rework)

### M5 — Noise and report quality · epic #477

- usage-limit warnings missing/wrong: #132 #230; awareness nudge via harness-cli #236
- #471 git-state banner noise; #478 task-cli notifications flood Telegram on bulk edits
- #116 quote the CTO's original words (tg#<id> → quoted preview)
- escalation/render gates: #210 #215–#219 #221–#227 #238 #242 #270 #300 #431; PDF sandbox #102 #104
- #95 #114 #142 #151 #163 #316 #428

### M6 — Later

Label `milestone:M6` only: `/tasks` Gantt and board (#26, #201, …), usage-report follow-ups, WhatsApp,
autostart on first run (#344), other nice-to-haves.

## Decisions

- Standing: harness-cli adapters (tg#16810); tmux name primary, harness title secondary, renames in
  place (2026-09-29); omp in and out of tmux, cc/codex tmux-only (2026-09-29).
- Taken during grooming (reversible): omp inside tmux without an omp-live endpoint gets tmux send-keys
  into its own TUI — that is the original process, not a second writer, so it does not reintroduce the
  ACP clone problem #450 removed.
- Pending CTO: BotFather "Disallow users to create new threads" for the bot (recommended: on), so
  topics are created by the bot, one per session.

## Grooming log (2026-09-29)

- Sources: Claude Code and omp transcripts + prompt history for tg-cli and rig-cli (2025-09-29 →
  2026-09-29; CC transcripts before June are auto-deleted, recovered from `~/.claude/history.jsonl`),
  the tg-ctl inbound history (07-20 → 09-26), the Forgejo tracker, agent-tools `ROADMAP.md`, live
  daemon logs and state, omp source and the omp-telegram package.
- 206 open issues groomed; every one carries `grooming:2026-09-29` and a milestone or a disposition.
- Closed (status cancelled, reason commented): 35 — obsolete ACP-era tickets #336 #343 #353 #379 #406
  #407 #411 #437 #443 #452; junk #161 #244 #284 #331 #332 #347; duplicates #70→#82, #408→#438;
  superseded recovery epics #380 #382–#397.
- Left open for review with `grooming:close-proposed` (medium confidence): 11.
- `ready-for-acceptance` (shipped with live evidence, needs acceptance proof before close): 43.
- New: epics #472–#477 (M0–M5) and 18 tickets #454–#461, #463–#471, #478; #462 (filed separately
  the same day) groomed into M2.
- Kept sub-epics: #377 (harness-cli migration, M2), #442 (Forgejo, M0).
