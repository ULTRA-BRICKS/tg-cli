# Question Inbox — design (approved by CTO 2026-10-13)

## Problem
The "⏳ still waiting on your decision for hatch request ship-skip-ci (see the original card above)" ping (#403 critical reminder, tg-ctl:12326-12420, features/tg-ctl/hatch-critical-reminder.ts) is useless: posted to General via plain sendMessage, no link, no buttons, no context. Live evidence: ONE orphaned critical hatch card `hatch-ship-skip-ci-a7077fb6780c` (cwd /home/ultra, opened 2026-10-11, asker long gone) is kept forever (retainMsFor → Infinity) and pinged every 15 min for ~2 days (88 `hatch-critical-reminder-sent` log lines). The #464 unanswered reminder ("⏳ N agent questions still waiting on you", features/tg-ctl/unanswered-reminder.ts, tg-ctl:12422-12463) has the same shape problem.

## Decisions (CTO)
1. Delete BOTH reminders (#403 and #464) entirely.
2. Add one forum topic "📥 Inbox" mirroring every currently-open question as a SILENT copy of the card with the same buttons.
3. A question leaves the open set only on relevance signals, NOT on a universal timeout.

## 1. Removal
- Delete features/tg-ctl/hatch-critical-reminder.ts, features/tg-ctl/unanswered-reminder.ts, their sweeps in tg-ctl, `criticalState` on PendingButton/AbandonedButton and in question-store.ts (RetainedQuestionRecord.criticalState/parseCriticalState — parser must tolerate and ignore the old field in existing files), `unansweredReminderState`/persistUnansweredReminder, CtlPaths.unansweredReminder, env TG_CTL_CRITICAL_REMINDER_INTERVAL_MS, TG_CTL_UNANSWERED_REMINDER_AFTER_MS, TG_CTL_QUIET_HOURS_* (quiet hours only exist for these reminders; verify no other user before deleting).
- Tests: delete tests/hatch-critical-reminder.test.ts, tests/unanswered-reminder.test.ts, tests/ctl-unanswered-reminder-integration.test.ts, the CRITICAL REMINDER REPLACEMENT test in tests/ctl-hatch-critical-wait-integration.test.ts (keep CRITICAL WAIT), criticalState round-trip in tests/ctl-question-store.test.ts.
- `formatAge` in text-util.ts stays if still used (Inbox shows age).
- One-shot startup migration: retire (deleteMessage, fallback edit — existing retireReminderMessage) any live reminder message referenced by an old `criticalState.lastReminderMessageId`/`lastReminderChatId` in questions.json and by `tg-ctl.<bot>.unanswered-reminder.json` (messageId/chatId), then delete that file. Idempotent.
- Critical mode itself (infinite ask wait, no UNSCOPED_ABANDON_MS timer for critical) stays.
- Docs: README.md:265-272, docs/ROADMAP.md:143-145, CHANGELOG (new entry; old entries stay as history), AGENTS.md section for the Inbox.
- Close/annotate tickets superseded: #569, #570, #518 (reminder parts), #554 (reminder parts).

## 2. Timeouts
- Remove retention-based removal of open questions: ABANDONED_RETAIN_MS (30 min question) and ABANDONED_PERMISSION_RETAIN_MS (12 h permission) no longer prune entries from abandonedButtons, and handlePostTimeoutQuestionReply's age check goes. Remove notifyAbandonedLongOutage expiry path accordingly (and restore-time expiry tg-ctl:~7926-7942) — an abandoned card stays answerable until a signal closes it.
- KEEP: the 115 s client hook budget (ASK_TOTAL_TIMEOUT_MS — harness-imposed; on expiry the card becomes abandoned, still open), grant TTL 24 h and GRACE_WINDOW_MS (security), answeredButtons replay cache (not an open question).
- Exception that IS a signal, not a timeout: a card with NO paneId and NOT a hatch request whose socket closed has nowhere to deliver → closed as "undeliverable" immediately (today's expireDeadCard behaviour for that class).
- Paneless HATCH cards whose socket closed stay open (a late Approve mints a grant).

## 3. Inbox topic
- Gate: only when ctx.cfg.topics || ctx.cfg.privateTopics and topicsCapable. Otherwise no Inbox, nothing posted to General.
- Daemon creates the topic once ("📥 Inbox", createForumTopic) and persists in new `tg-ctl.<bot>.inbox.json` (CtlPaths.inbox, atomicWrite): `{version:1, chatId, threadId, mirrors: {<key>: {messageId}}}`. If posting into the topic fails with "thread not found"/topic deleted → recreate topic once, repost mirrors. chatId change (tg auth rebinding) → reset.
- Open set = pendingButtons ∪ abandonedButtons without queuedDecision (same collection the #464 sweep used, critical included).
- Mirror message: `disable_notification: true`, into Inbox thread. Content: session label (resolveSessionName primary), kind (question / permission / hatch <hookId>), age at post time, the question text (same rendering as the card, honour hatchParseMode HTML), the SAME inline keyboard as the original card (same callback_data), plus a "✕ Неактуально"/"✕ Dismiss" button that reuses the existing `close-question-card` action (English UI strings consistent with the rest of tg-ctl).
- Taps on a mirror must work exactly like taps on the original: extend the messageId guards (tg-ctl answer-question ~12027-12034, and ~11505-11512, lateDeliver paths, cardReplyAction text-reply-to-card) to accept the mirror's messageId for that key. A text reply to the mirror = reply to the card.
- On close (any path): delete the mirror message (deleteMessage; fallback edit to closed text without keyboard), and edit the ORIGINAL card with the close reason (existing edit paths where they exist).
- Sync: pure planner `planInboxSync(open, state) → {post: keys[], remove: keys[]}` in features/tg-ctl/inbox.ts; daemon runs it after every persistQuestions mutation and once per poll tick as a safety net. Failed send → not recorded, retried next tick. Startup: reconcile (mirrors for keys no longer open are removed; missing ones posted).
- Link to the original card is impossible (private chat, no public message URLs) — not attempted.

## 4. Close signals (in addition to existing tap / text reply on card / ✕ / reconnect-with-answer)
| Signal | Behaviour | Card/mirror status |
|---|---|---|
| Answered the agent another way | Free-text inbound for session S (routed to a pane/host/omp whose session has EXACTLY ONE open card, and the text is NOT a reply to some other message). Live question card: the text is answered down the hook socket as the answer value (formatAgentHookOutput with value=text). Live permission: yes/ok/да/ок (reuse existing yes/no parsing from cardReplyAction) → allow, no/нет → deny, any other text → deny with the text as deny reason (decision.message / permissionDecisionReason — pass as answer label so the model gets it). Abandoned question with pane: inject the text into the pane like handlePostTimeoutQuestionReply. Abandoned permission/hatch: do NOT auto-decide; text goes through the normal deferred path. | "✓ answered in chat: <text>" |
| Same, but session has >1 open cards | No auto-answer; text stays deferred as today; bot replies once "this session has N open questions — reply to the card you mean". | — |
| New hatch request same hookId+cwd | New card closes older open cards with the same (hookId, cwd). | "↻ superseded by a newer request" |
| Hatch decided | A tap (live or late) on one card or a consumed grant (handleVerifyGrantRequest) closes all other open cards with same (hookId, cwd). | "✓ decided" |
| Explicit withdraw | Socket protocol line `{"withdraw": "<requestId>", "reason": "..."}` (and `{"withdrawHookId": "<id>", "cwd": "..."}`). `tg-ctl ask` client installs SIGTERM/SIGINT/SIGHUP handlers that send withdraw for its in-flight requestIds BEST-EFFORT before exiting (SIGKILL cannot be caught — then the daemon only sees socket close; that card stays open per CTO decision, closable via Dismiss). New subcommand `tg-ctl withdraw <requestId> | --hook-id <id> [--cwd <dir>] [--reason <text>]` for wrappers (agent-tools hatch helper can call it). | "⏹ withdrawn: <reason>" |
| Dismiss button | ✕ on mirror or original → close-question-card. | "✕ dismissed" |

Socket close WITHOUT withdraw (e.g. harness SIGKILL after the user answered in the TUI) keeps today's semantics: card → abandoned, still open, still in Inbox. Known accepted risk (CTO declined a "session died" signal): stale cards need a Dismiss tap. The current orphan hatch-ship-skip-ci card will appear in Inbox after deploy.

## 5. Testing
- Pure: planInboxSync diff; hatch sibling selection by (hookId,cwd); free-text-to-answer mapping (question / permission yes/no/other).
- Integration (existing fake Bot API harness used by tests/ctl-*-integration.test.ts): mirror appears silent with keyboard and is deleted after tap on original; tap on mirror answers the agent; withdraw line closes card+mirror; tg-ctl withdraw --hook-id; free-text answer with one open card answers the socket; >1 open cards → notice, no auto-answer; new hatch with same hookId supersedes old; old reminder state migrated (messages deleted, file removed); abandoned question no longer expires after ABANDONED_RETAIN_MS.
- No full local suite: the workstation is overloaded. Locally at most ONE test file at a time. Full suite via `runpod-run -- bun test ./tests` (skill runpod-offload; add `--apt tmux` etc. if suite needs it; check AGENTS.md for repo flags). Ensure `runpod-run --status` shows no leftover pod.
