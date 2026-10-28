// Result/option types of the argv parser. Re-exported from ./args (the single public surface).

export interface ItemLineSpec {
  // The full original token as written (e.g. "src/a.ts:42-50"), kept so the
  // quote can be anchored on it in the caption.
  token: string;
  startLine: number;
  endLine: number;
  col: number | undefined;
}

export interface Item {
  type: 'photo' | 'document';
  path: string;
  // Present only when the explicit --file path is named with a trailing
  // line-spec in the text (`--file x.ts "see x.ts:42"`). Absent otherwise so
  // no-spec parse results stay byte-identical (keeps toEqual assertions green).
  lineSpec?: ItemLineSpec;
}

export type Format = 'plain' | 'html';

export type ParseResult =
  | { action: 'help' }
  | { action: 'version' }
  | { action: 'lsEmojiHelpers' }
  | { action: 'detectModel' }
  | { action: 'detectAgent' }
  | { action: 'sessionTopic' }
  | { action: 'sessionId' }
  | { action: 'formatHelp' }
  | { action: 'error'; message: string }
  | {
      action: 'send';
      items: Item[];
      caption: string;
      format: Format;
      // Explicit header title (`--title`). Appears on the `✳️ [window]` line as
      // `✳️ [window] <title>`. The message body is NEVER pulled up here.
      title?: string;
      // Explicit message tag (`--tag`). Rendered as a wordmark pill (custom-emoji
      // cells + readable word): `✳️ [window] 🔵 ANSWER`. Composes with `--title`.
      tag?: string;
      // Explicit SUBAGENT self-label (`--subagent <name>`; the deprecated
      // `--agent` alias still parses). Appears as its own `[name]` bracket right
      // after `[window]`: `✳️ [window] [name] <title>`. The MAIN/orchestrator
      // agent needs NO flag — its `[window]` bracket already carries the project
      // (resolveSessionName derives it from the tmux window / cwd). This
      // flag is for a Task-tool SUBAGENT to identify WHICH subagent sent the
      // message (e.g. `--subagent hyperide-fixer`). Claude Code / Codex / opencode
      // in-process subagents share the parent's env, so no env signal can
      // label them (docs/specs/agent-role-model.md); omp / detached children
      // are labelled from RIG_AGENT_ID without a flag.
      subagent?: string;
      // code-as-pdf: also attach the raw original file alongside the rendered
      // PDF (`--with-original`). Default is PDF-only for code/config files.
      withOriginal?: boolean;
      // code-as-pdf: skip the PDF render entirely and attach the original file
      // (`--no-pdf`) — today's behavior. Wins over --with-original.
      noPdf?: boolean;
      // code-as-pdf: device preset for the mobile PDF page geometry
      // (`--pdf-device <name>`, e.g. iphone15pro / a4). Overrides TG_PDF_DEVICE.
      pdfDevice?: string;
      // Threaded reply (`--reply-to <message_id>`): sets reply_to_message_id on
      // the outbound sendMessage so it threads UNDER that inbound Telegram
      // message. The id is Telegram's own per-chat sequential message_id (the
      // daemon surfaces it in the injected wrap as `tg#<id>`). Absent when the flag
      // is not given (keeps no-flag send results byte-identical).
      replyTo?: number;
      // Forum topic (`--topic <id>`): sets message_thread_id on EVERY outbound
      // send so an agent's `tg` reply threads INTO its bound topic instead of
      // General (docs/specs/tg-forum-topics.md §8). The id is the topic's
      // message_thread_id. The entrypoint falls back to the TG_TOPIC env when the
      // flag is absent; an explicit flag wins. Absent (and no TG_TOPIC) keeps
      // no-flag send results byte-identical for the 1:1 path.
      topic?: number;
      // Session pin (`--session <id>`, tg-cli#709): the registry session this send belongs to
      // — a session id or its `omp:<id>` key, as `tg --session-id` prints it. It replaces the
      // process-tree lookup for the header title, the session topic and the reply route. The
      // entrypoint falls back to the TG_SESSION env; the flag wins.
      session?: string;
      // `tg --table`: read delimited rows from stdin, render an aligned <pre>
      // monospace table, and send it (composes with --tag/--title). The flag is
      // a boolean; the rows come from stdin, not argv. Absent when not given.
      table?: true;
      // `--dry-run`: validate and render the message through every LOCAL guard
      // (escalation-format gate, cjk/mixed-script guard, table/pipe-table
      // conversion) and print the outcome, but perform NO network call and
      // require NO credentials. Lets an agent iterate against the strict
      // `--tag decision` structural gate without leaking
      // scaffold/placeholder drafts to the real chat — see the entrypoint's
      // dry-run short-circuit (features/cli comment "dry-run short-circuit")
      // for the exact cutoff (text guards run; photo/document/PDF plan
      // building and any send do not). Absent when not given.
      dryRun?: true;
      // `--automated`: the body is generated by a program (a monitor alert, a
      // scheduled digest), not written by an agent. The intent gate
      // (features/cli/intent-gate.ts) skips layout checks for it, but explicit
      // problem reports still require past actions/results and current recovery.
      // Asks are still detected. Absent when not given.
      automated?: true;
      // `--terminal-question`: the HIDDEN escape for the `answer`-requires-
      // `--reply-to` gate. The answered question originated in the TERMINAL (the
      // Claude/agent harness) where there is no inbound Telegram message_id to
      // reply to, so an `--tag answer` legitimately has no `--reply-to` target.
      // This flag — and ONLY this flag — permits that. It is DELIBERATELY absent
      // from USAGE/`--help`: the only place it is surfaced is the error raised
      // when `--tag answer` lacks `--reply-to`. Absent when not given, so a
      // normal send result stays byte-identical.
      terminalQuestion?: true;
      // Tier-1 escalation-format ADVISORY (WARN-mode default): set when a
      // `--tag decision` send carries no literal table. parseArgs
      // does NOT block on it — it attaches the copy-pasteable guidance here and
      // still returns a `send`. The entrypoint prints it to stderr and, ONLY
      // when the off-by-default `ESCALATION_GATE_ENFORCE` flag is set
      // (escalationGateEnforced), upgrades it to a hard stop (exit 1). This is
      // the skill-first → warn → later-flip-to-block rollout: nothing hard-
      // blocks a decision send today. Absent (undefined) on every
      // other send, so those results stay byte-identical.
      escalationWarning?: string;
    };

export interface ParseOptions {
  // Message body read from stdin. It is added to the text after the argv loop, so it is never
  // tokenized: a body such as "- a" or "--tag x" stays text instead of an unknown flag.
  bodyText?: string;
  // Never-attach denylist (feature `attach-denylist`, ON by default): an explicit
  // --photo/--file naming a secret-looking file (.env family, private keys,
  // credential rc-files, …) is a HARD ERROR.
  attachDenylist?: boolean;
  // Message-reference autolinking (feature `autolink-msgrefs`, ON by default): gates the
  // `--title` tg#<id> guard below, mirroring the SAME flag the body-detection call in the `tg`
  // entrypoint already gates on. With the feature off, a `tg#<id>` is inert plain text (no
  // linkify, no gate) in BOTH the title and the body — consistent, rather than banning it from
  // the title while the identical literal is freely allowed in the body (task-cli#45 / tg-cli
  // review finding on PR #139).
  msgrefAutolink?: boolean;
  // Ticket-code autolinking (feature `autolink-tasks`, ON by default): gates the `--title`
  // HYP-<id> guard below, mirroring the `msgrefAutolink` gating of the tg#<id> guard. A bare
  // ticket code in the one-line header is inert (nothing there ever linkifies it) and only
  // duplicates a body reference the reader can follow — the same rule task-cli/gh-ship enforce
  // on a ticket title (tg-cli#116). With the feature off, a `TEAM-123` is inert plain text in
  // BOTH title and body, so it must not be banned in one and allowed in the other.
  ticketAutolink?: boolean;
}

export type ParseError = { action: 'error'; message: string };
