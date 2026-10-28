// The `tg --help` text (tg-cli#817: moved out of the entrypoint verbatim).
export const USAGE = `Usage:
  tg "text message"
  tg --photo screen.png "caption"
  tg --file doc.pdf "caption"
  tg --photo a.png --photo b.png "caption"   # repeatable; mix --photo/--file
  tg "see AGENTS.md"            # text only: paths in the text are never attached
  tg --reply-to 1234 --tag answer "answer"  # thread under inbound message 1234
  tg --topic 7 "status"         # post INTO forum topic 7 (else TG_TOPIC)
  printf 'task\\tstatus\\nship\\tdone' | tg --table   # aligned <pre> table
  tg auth                       # connect to Telegram in one step (token + one Start tap)
  tg auth status                # bot, chat, and your user/caller accounts (tg help auth)
  tg voice setup [--dry-run]    # configure inbound voice→text (local Whisper STT; installs a
                                 # prebuilt one when none is found; --dry-run shows the plan)
  tg report --title <t> --ticket <id> --impact <t> --verify-cmd <c> --verify-result <r> [--photo <p>]... [--file <p>]...
                                 # structured result report → Telegram (tg help report)
  tg --tag report < msg.txt     # message body from stdin (also: cat msg.txt | tg -)
  tg obligations                # follow-ups the intent gate says you still owe (tg help obligations)
  tg chatgpt list|show|pause|resume|continue …   # ChatGPT session control via pm (tg help chatgpt)
  tg --ls-emoji-helpers

As YOUR Telegram account (MTProto; see \`tg help auth\`, \`tg call --help\`):
  tg auth user                  log in once: phone + code (+ 2FA), or --qr
  tg auth caller                log in a second account that can ring you
  tg call @alice --say "text"   ring a user and speak (or --audio file.ogg)
  tg call me --say "text"       ring YOURSELF from the caller account
  tg user send @alice "text"    send as you (text or stdin)

The global options (--format, --tag, --title, --subagent, --reply-to, --topic, the feature
toggles) apply to ANY of the bot send forms above — see Options below. The account
commands take only their own flags.

Help topics (\`tg help <topic>\`):
  format   what Telegram message formatting supports (HTML tags / entities)
  config   configuration keys, types, defaults, and editor schema
  report   the structured result report (tg report)
  auth     connecting to Telegram: the bot (login / status / logout) and your own
           accounts (tg auth user|caller), exit codes
  obligations  the follow-up replies the intent gate recorded (list / --check / dismiss)
  chatgpt  ChatGPT session control through pm: list, show, pause/resume/watch/continue requests

Readable long messages:
  For longer status reports, avoid one dense plain-text block. Use headings,
  blank-line paragraphs, lists, or tables so the Telegram message is scannable.
  Use --format html for rich headings, lists, and native tables when useful;
  use tg --table for a plain aligned fallback grid.

Send output:
  Successful sends print OK first. When Telegram returns message ids, the same
  line includes reusable refs: OK tg#123, or OK tg#123 tg#124 for a multi-message
  send. Failed sends do not print refs.

Options:
  --format plain|html  message format (default: plain). A global modifier on
                       every send form above (text, photo, file, table).
  --photo <path>       attach an image (repeatable)
  --file <path>        attach a document (repeatable)
  --with-original      for code/config files: also attach the RAW file next to
                       the rendered PDF (default sends ONLY the PDF)
  --no-pdf             for code/config files: skip the PDF, attach the raw file
                       (today's behavior)
  --pdf-device <name>  mobile PDF page size for code/config files. Default
                       iphone15pro. Also: iphone15promax, iphonese, a4.
                       Overrides TG_PDF_DEVICE.
  --title <text>       explicit header title: "✳️ [window] <title>" (the message
                       body is NEVER pulled onto the header line)
  --tag <tag>          wordmark pill labeling the message; composes with --title:
                       "✳️ [window] 🔵 ANSWER — <title>". Premium clients show the
                       custom-emoji pill; everyone else sees the unicode fallback
                       below. Tags are LOWERCASE ENGLISH ONLY (uppercase /
                       Cyrillic / unknown are rejected with an error):
                         answer    🔵 ANSWER    answering a question
                         decision  🟠 DECISION  a decision to confirm
                         problem   🔴 PROBLEM   a blocker / problem
                         report    🟢 REPORT    a status / result report
                       An open question for the recipient IS a decision
                       request: send it as --tag decision (the former
                       --tag question is refused with that hint).
                       decision is an ESCALATION: it REQUIRES the
                       decision-request format (deny-by-default) — options as a
                       real table/list with pros/cons, a recommendation, context,
                       a glossary of internal names, a file:line "where to look",
                       and readable structure (headings, bullet lists, <hr>) sent
                       with --format html.
                       A malformed send is BLOCKED (exit 1) with a checklist.
                       Markdown pipe grids auto-convert to a <table>. The one
                       documented escape is ESCALATION_GATE_ENFORCE=0 (downgrade
                       to advisory). See 'tg help format' for a good example.
                       The INTENT GATE applies the same formats to UNTAGGED
                       agent messages: a prose question is blocked, a report
                       that also asks something is sent but owes the question
                       as a decision reply (tg obligations). 'tg help format'.
  --subagent <name>     a SUBAGENT self-label: adds a second bracket after the
                       window → "✳️ [window] [name] <title>", so the recipient can
                       tell WHICH subagent sent the message. The MAIN/orchestrator
                       agent needs NO flag — its [window] bracket already carries
                       the session name (the tmux window name, or its cwd basename
                       when the window is auto-renamed to a version/shell; outside
                       tmux the harness session title). A subagent that
                       dispatched itself as a separate process is labelled from
                       its launcher env with no flag (RIG_AGENT_ID=<name>, or
                       RIG_DETACHED_AGENT=1 → [detached]; omp sets RIG_AGENT_ID
                       on its task subagents). Claude Code / Codex / opencode
                       IN-PROCESS subagents share their parent's env, so they
                       MUST pass this flag. Precedence: --subagent > TG_AGENT
                       env > RIG_AGENT_ID > RIG_DETACHED_AGENT. Deprecated
                       alias: --agent. Check the auto [window] label for the
                       current shell: --detect-agent.
  --session-topic      print the forum topic id of the session this shell runs
                       in (created on first ask), or nothing. A launcher of a
                       detached child exports it: TG_TOPIC=$(tg --session-topic).
  --session-id         print the registry key of the session this shell runs in
                       (e.g. omp:01a1…), or nothing. Hand it to a background job
                       as TG_SESSION: omp runs its jobs under a shared broker whose
                       process tree names no session.
  --session <id>       pin the send to a registry session (its id or omp:<id> key):
                       header title, session topic and reply route name it instead
                       of the process tree. Falls back to the TG_SESSION env; the
                       flag wins. A pin naming no live session warns and sends
                       with no session (General).
  --reply-to <id>      thread the outbound message UNDER an inbound Telegram
                       message (sets reply_to_message_id). The id is the inbound
                       message's Telegram message_id — the tg-ctl daemon surfaces
                       it in the injected wrap as "[TG from Alex tg#<id>]". The
                       answer tag REQUIRES this: answering means answering a
                       SPECIFIC message. The reply posts into the topic that
                       message sits in (General stays General).
  --topic <id>         post INTO a forum topic: sets message_thread_id on every
                       outbound message so an agent's reply threads into its
                       bound topic instead of General (forum chats only). Falls
                       back to the TG_TOPIC env when the flag is absent; the flag
                       wins. With neither, a tg inside a registry session posts
                       into that session's own topic when control.topics is on
                       (a --reply-to follows its message's topic first);
                       otherwise to General.
  --table              read delimited rows from STDIN (TSV, or "a | b" per line),
                       render an aligned monospace table wrapped in <pre>, and
                       send it. The plain FALLBACK grid; a REAL native bordered
                       table comes from --format html with <table> (auto-sent
                       as a Rich Message). Composes with --tag/--title; any argv
                       text becomes a heading above the table. Keep cells
                       ASCII/Cyrillic (double-width emoji/CJK misalign columns).
  --dry-run             validate/render the message through every local guard
                       (escalation-format gate, cjk-guard, screenshot-guard, file-mention-guard, dictionary gate, intent gate, dimension gate, table conversion) and
                       print the outcome — NO network call, NO credentials
                       required, NOTHING is sent. Use this to iterate against
                       the strict --tag decision format instead of
                       testing it with real sends (a real send that happens to
                       pass structurally still delivers to the live chat, even
                       if the content is a placeholder draft).
                       With --photo/--file it checks each attachment too
                       (ok / would be skipped) and uploads nothing.
  --automated          the body is generated by a program (a monitor alert, a
                       scheduled digest): skips layout checks, but a problem
                       still needs actual attempts/results and current recovery.
  -v, --version        print version and exit
  -h, --help           print this help and exit

Topic help:
  tg help config       the configuration reference; aliases: tg config help,
                       tg config --help, tg config -h.
  tg config validate   check config.yaml against that reference (read-only;
                       exit 1 on errors; see tg config validate --help).
  tg help format       the Telegram message-formatting reference (supported
                       HTML tags / entities). The canonical form; the old
                       --format-help flag still works as an alias.

Attachments:
  Only --photo and --file attach a file from disk. A path written in the
  message text stays plain text and is never attached, even when the file
  exists. (A fenced code block over 1024 chars pasted into the text is still
  sent as a fragment document — that is the message's own content.)

Autolink tasks (feature, ON by default — toggle with --feature/--no-feature):
  Ticket-like codes in the text (3 uppercase letters + dash + digits, e.g.
  HYP-576) are verified via the linear CLI and linked to their Linear issues.
  One ticket: its title is added to the first line. Several: a collapsed
  reference block (code: title) is appended. Codes Linear doesn't know are
  left as plain text. Requires the linear CLI (brew install schpet/tap/linear)
  and linear auth login; without them the message is sent unchanged.
  Verified results are cached for 1 hour (~/.cache/tg-cli/linear-cache.json).
  Disable with --no-feature autolink-tasks or features.autolink-tasks: false
  in ~/.config/tg-cli/config.yaml.

Message refs (feature, ON by default — toggle with --feature/--no-feature):
  An inbound message id quoted back as tg#<id> (the form the inbound wrap
  renders, e.g. [TG from Alex tg#1234]) is recognized as a Telegram-message
  reference — distinct from a GitHub #<id>, so it is never mis-linked as an
  issue/PR. In a supergroup it becomes a t.me link; in a private DM it is
  marked but unlinked (no public per-message URL exists). Disable with
  --no-feature autolink-msgrefs or features.autolink-msgrefs: false.
  When the referenced message is in this machine's history, the ref is quoted
  inline instead: «first 48 chars of that message…» (tg#1234) — in a
  supergroup the quote is the t.me link. Up to 8 refs per message; the rest
  keep the marker plus a collapsed excerpt block at the bottom. Disable with
  --no-feature autolink-msgref-preview.

Markdown as PDF (feature, ON by default — toggle with --feature/--no-feature):
  Attached .md/.markdown files are converted to PDF before sending (pandoc +
  headless Chrome; emoji and Cyrillic render correctly). Requires pandoc and
  Google Chrome (override binary with TG_CHROME_PATH); on any failure the
  original .md is attached unchanged. Disable with --no-feature md-as-pdf.

Code as PDF (feature, ON by default — toggle with --feature/--no-feature):
  Attached code/config files (.ts, .tsx, .js, .json, .yaml, .toml, .py, .go,
  .rs, .sql, Dockerfile, …) are rendered to a MOBILE, syntax-highlighted,
  soft-wrapped PDF (pandoc skylighting + headless Chrome). Telegram iOS previews
  the raw source uselessly; the PDF is the readable artifact on a phone.
  BY DEFAULT only the PDF is sent — the raw file is NOT attached. Adjust:
    --with-original  attach the raw file alongside the PDF
    --no-pdf         skip the PDF, attach the raw file (today's behavior)
    --pdf-device <n> page size: iphone15pro (default), iphone15promax,
                     iphonese, a4. Also TG_PDF_DEVICE / TG_PDF_THEME (pandoc
                     highlight style, default tango).
  Requires pandoc + Google Chrome (override with TG_CHROME_PATH); on any failure
  the original file is attached unchanged. Markdown stays on the md-as-pdf path.
  Disable with --no-feature code-as-pdf.

Missing/empty/unreadable attachments:
  A disk attachment (explicit --photo/--file) that goes missing,
  is truncated to 0 bytes, or loses read permission between parsing and send is
  skipped with a stderr warning naming the path and the reason — the rest of the
  send (including the text) still goes out. No toggle: this is a correctness fix,
  not an optional feature.

Message-flood cap (feature flood-cap, ON by default — toggle with
--feature/--no-feature):
  A message that would fragment into more than 6 separate Telegram sends
  (Telegram's ~4096-char message limit) is REFUSED before anything is sent, with
  a local error naming the exact character count and the message count it would
  have produced — instead of silently flooding the recipient with dozens of
  fragments. Rich messages (--format html bodies using table/heading/list/formula
  tags) are exempt — they always send whole. Override with --no-feature flood-cap
  or features.flood-cap: false in ~/.config/tg-cli/config.yaml.

Attachment encoding:
  Text documents containing non-ASCII UTF-8 get a BOM prepended to the
  UPLOADED COPY (the file on disk is untouched) so Telegram's preview detects
  the encoding correctly.

Never-attach denylist (feature, ON by default — toggle with --feature/--no-feature):
  Secret-looking files are NEVER attached: the .env family (.env, .env.local,
  prod.env), SSH private keys (id_rsa, *.pem, *.key, *.p12, *.pfx, *.ppk),
  credential rc-files (.netrc, .npmrc, .pypirc, .git-credentials, .pgpass),
  shell histories, *.tfvars, credentials.json / client_secret*.json,
  kubeconfig. An explicit --photo/--file of such a file is an ERROR. Override
  consciously with --no-feature attach-denylist.

Stray-CJK / mixed-script guard (feature cjk-guard, ON by default — toggle with
--feature/--no-feature):
  A message (or --title) with a LONE CJK / ideographic character stuck mid-word
  into otherwise Latin/Cyrillic text (e.g. a garbled "ка<CJK>eat") is a HARD
  ERROR: the offending character and its position are named so you re-send
  clean. Only a lone CJK codepoint immediately FOLLOWED by a letter is flagged,
  so a genuinely CJK message, a bilingual word (Deploy到生产), and a CJK suffix
  (iOS版) pass untouched.
  The SAME feature flag also hard-blocks a mixed-script "garbage word" token —
  a single contiguous run of letters whose script switches between Cyrillic and
  a foreign alphabet (Latin, Greek, …) twice or more, in EITHER direction: a
  foreign fragment inside Cyrillic ("почčesна") or a Cyrillic letter inside a
  foreign word ("mіr"). Invisible format characters (zero-width space, soft
  hyphen) do not split a run. Two SEPARATE words (влил PR), a hyphen-joined
  compound (PR-ревью), a glued acronym+suffix (IDшник), and dev slang wrapping
  one English stem in Cyrillic (заpushил, антиDDoSный) pass untouched.
  Override either check with --no-feature cjk-guard or features.cjk-guard: false.

Screenshot-attach gate (feature screenshot-guard, ON by default — toggle with
--feature/--no-feature):
  A message (or --title) that mentions screenshot or скриншот (any case) with
  NO photo/image attached is a HARD ERROR before send. Attach the image with
  tg --photo <path> (or equivalent). Do not dodge by deleting the word —
  attach the screenshot. A send that already has --photo is allowed. Override
  with --no-feature screenshot-guard.

Unattached-file gate (feature file-mention-guard, ON by default — toggle with
--feature/--no-feature):
  An agent message whose prose names an existing local document — an
  absolute, ~/ or ./ path to a non-empty, non-executable, group/other-readable
  regular file under home or the temp dir, within the 50 MB upload limit —
  that the send does not attach is a HARD ERROR before send: the reader sees
  only a path. The error prints the exact resend command with --file <path>.
  The text never attaches a file by itself. Paths in code (backticks, <code>,
  <pre>, fenced blocks), on a "$ " command line, in a URL; directories,
  missing, system, executable, private (0600) and never-attach files do not
  count; --automated sends are not gated.
  Override with --no-feature file-mention-guard.

Model-render dimension gate (always ON, no feature toggle):
  An agent message that attaches an image (--photo, or --file *.png/.jpg/
  .webp/.gif) from a 3D context — a cwd or image path in a 3D project (under a
  garage-band / 3d-cli checkout's projects/ tree, or below a 3d.yaml), or a
  caption naming 3D work (a .stl/.3mf/.scad file name, G-code, PLA/PETG filament,
  K1 SE, "3D print|model|render", модель для печати, ложка) — must attach a render that carries legible dimensions: an
  <image>.dims.json sidecar written by "3d dimension MODEL -o <image>" that
  passes "3d dimension --check <image>" (font >= 14 px at 1280 px, labels not
  overlapping each other or the part, contrast, inside the frame). Otherwise
  it is a HARD ERROR before send listing what is missing and the commands to
  render and check it. --automated sends are not gated.
  A non-model image (a thumbnail, a UI screenshot) goes out only with a
  written reason: RIG_HATCH_REQUEST_TG_DIMENSIONS_SKIP="<why>" tg --photo …
  sends the reason to the owner as ONE approval request (tg-ctl ask, deny by
  default; never under --dry-run); no approval or a reason shorter than 3 words /
  15 characters = blocked.

Unknown flags:
  Unknown dashed tokens (e.g. --foo) are an ERROR: this help is printed to
  stderr and the process exits non-zero. They are NOT sent as message text.

Text escape handling:
  Message text and captions convert \\n, \\r, \\t, and \\\\ into real newlines,
  carriage returns, tabs, and backslashes. File paths are not decoded.

Emoji helpers (custom emoji):
  Use :codex:, :gemini:, :claude:, :deepseek:, :qwen:, :kimi:
  :o3:, :o1:, :gpt4:, :gpt3:, :gpt:, :llama:, :ollama:, :mistral:, :grok:, :copilot:
  :perplexity:, :cursor:, :windsurf:, :devin:, :aider:, :continue:, :omp:
  :hyperide:
  to embed custom emoji icons from the HyperIDE.ai set.
  Set: https://t.me/addemoji/agents_by_HyperIDE_Bot

Unicode-only helpers (no custom emoji ID):
  :glm: → 🗂, :chatglm: → 🗂, :fireworks: → 🎆
  Set emoji IDs via env vars: TG_EMOJI_ID_<model> or TG_EMOJI_IDS JSON.
  Run --ls-emoji-helpers to see available helpers and their current status.

Formats:
  plain  Send text as-is. This is the default.
  html   Send with Telegram Bot API parse_mode=HTML.

HTML tags supported by Telegram Bot API:
  <b>, <strong>, <i>, <em>, <u>, <ins>, <s>, <strike>, <del>,
  <span class="tg-spoiler">, <tg-spoiler>, <a href="...">,
  <tg-emoji emoji-id="...">, <tg-time unix="..." format="...">,
  <code>, <pre>, <pre><code class="language-...">,
  <blockquote>, <blockquote expandable>

Only those HTML tags are supported. Escape raw <, >, and & outside tags as
&lt;, &gt;, and &amp;.

Exit codes (send):
  0   sent        1   failed (Telegram refused it, a guard blocked it)
  75  queued: Telegram kept failing (5xx, 429, timeout, connection reset) through
      the retry budget (TG_SEND_RETRY_BUDGET_MS, default 60000) — the unsent rest is
      in the outbox and the tg-ctl daemon delivers it, marked as delayed
  78  not connected to Telegram (no bot token or chat configured) — run \`tg auth\`
  (tg auth has its own codes: tg help auth)
`
