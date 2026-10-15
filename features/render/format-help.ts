// --- Formatting reference (`tg --format-help`) ---
//
// A concise, copy-pasteable reference for what Telegram message formatting
// ACTUALLY supports, so agents stop guessing. Grounded in the June 2026 Bot API
// (10.1, which added Rich Messages): `--format html` has TWO tiers, chosen
// automatically by what tags the body contains —
//   1. BASIC: only the small inline allowlist (b/i/u/s/code/pre/a/blockquote/
//      tg-emoji/tg-time/spoiler) → sent via sendMessage (parse_mode=HTML).
//   2. RICH: the body includes a rich-only tag (<table>, <h1>..<h6>, lists,
//      <hr>, <details>, LaTeX formulas, media) → the SAME `--format html`
//      auto-sends a native Rich Message (sendRichMessage) with real bordered
//      tables, headings, lists and rendered formulas.
// ONE flag (`--format html`); tg routes by content. No --rich flag exists.
//
// Pure: FORMAT_HELP is a constant string; formatHelp() returns it so the
// entrypoint stays symmetric with the other --*-help / info actions.

export const FORMAT_HELP = `tg / Telegram message formatting (Bot API 10.1, June 2026)

Send HTML with --format html. tg picks the send method AUTOMATICALLY from the
tags you use — there is ONE flag, no --rich:

  • BASIC tags only  → normal message (sendMessage, parse_mode=HTML).
  • Any RICH tag      → native Rich Message (sendRichMessage): real bordered
    tables, headings, lists, dividers, collapsible details, LaTeX formulas.

BASIC tags (inline; these alone keep the normal send path):
  <b>bold</b>            / <strong>bold</strong>
  <i>italic</i>          / <em>italic</em>
  <u>underline</u>       / <ins>underline</ins>
  <s>strike</s>          / <strike>…</strike> / <del>…</del>
  <code>inline code</code>
  <pre>preformatted block</pre>
  <pre><code class="language-ts">const x = 1</code></pre>
  <a href="https://example.com">link</a>
  <blockquote>quoted</blockquote>
  <blockquote expandable>long quote, collapsed by default</blockquote>
  <span class="tg-spoiler">hidden</span>  / <tg-spoiler>hidden</tg-spoiler>
  <tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>   (premium custom emoji;
    must wrap EXACTLY ONE emoji or Telegram rejects the message)

RICH tags (any ONE of these auto-routes the SAME --format html to a Rich Message):
  <h1>Heading</h1> … <h6>…</h6>     headings
  <p>paragraph</p>  <hr/>           paragraphs, dividers
  <ul><li>item</li></ul>            unordered / ordered lists
  <ol><li>item</li></ol>
  <table> … </table>                NATIVE bordered tables (see example below)
  <details><summary>t</summary>…</details>   collapsible block
  <footer>…</footer>  <aside>pull quote</aside>
  <mark>…</mark>  <sub>x</sub>  <sup>2</sup>
  <tg-math>x^2 + y^2</tg-math>      inline LaTeX formula
  <tg-math-block>E = mc^2</tg-math-block>   block LaTeX formula
  <img src="https://…"/> <video …> <audio …>   media blocks (HTTP/HTTPS only)

Native table example (auto-sends a Rich Message):
  tg --format html '<table bordered striped>
  <tr><th>task</th><th>status</th></tr>
  <tr><td>ship</td><td align="center">done</td></tr>
  </table>'
  Cell align: align="left|center|right", valign="top|middle|bottom";
  colspan / rowspan supported; <caption> for a table title.

Markdown pipe grids are AUTO-CONVERTED:
  Telegram itself does not render a markdown grid — a body like
      | Option | Cons |
      | ---    | ---  |
      | A      | slow |
  would otherwise arrive as literal pipes and dashes. tg detects that shape and
  rewrites it to a real <table> (routed as a Rich Message), so you can type a
  quick pipe grid and still get a rendered table. For full control, author the
  <table> yourself with --format html.

HTML entities (tier-specific) — all NUMERIC entities work in both tiers. Named:
  BASIC send:  only &lt; < · &gt; > · &amp; & · &quot; "  (no others — a
               &nbsp; / &hellip; / &mdash; in a basic message is sent literally).
  RICH send:   the four above PLUS &apos; ' · &nbsp; · &hellip; · &mdash;
               &ndash; · &lsquo; · &rsquo; · &ldquo; · &rdquo;.
  Escape raw < > & in your text either way.

Rich Message limits (sendRichMessage):
  ≤ 32768 chars · ≤ 500 blocks (incl. list items / table rows / nested) ·
  ≤ 16 nesting levels · ≤ 50 media attachments · ≤ 20 table columns.
  tg pre-flights these and errors clearly before sending if you exceed them.

Plain fallback table (--table):
  \`tg --table\` renders a padEnd-aligned, box-drawn MONOSPACE table wrapped in
  <pre> — the plain fallback when you want a quick aligned grid without authoring
  HTML. A REAL bordered table comes from --format html with <table>.
    printf 'task\\tstatus\\nship\\tdone\\nreview\\twip' | tg --table

Header badge (--tag / --title), composes with BOTH basic and rich sends:
  --title "<text>"   explicit headline on the \`✳️ [window]\` line (renders as the
                     header line above a rich body too).
  --tag <tag>        a labeling pill: lowercase english only —
                     answer/decision/problem/report. Composes with --title.
                     An open question for the recipient is a decision request:
                     send it as --tag decision (--tag question was removed).
  --reply-to <id>    thread the message under an inbound Telegram message
                     (sendMessage: reply_to_message_id; sendRichMessage:
                     reply_parameters). The answer tag REQUIRES this.

--tag decision (ESCALATION) — REQUIRED format (deny-by-default):
  An escalation asks the CTO to choose, so it MUST be a self-contained,
  STRUCTURED Rich Message the human can answer in ~30s without opening the repo
  AND without reading a wall of text. tg BLOCKS a malformed decision
  send (exit 1) and lists what's missing. Required sections (skill:
  decision-request-discipline):
    • Context — one line: where the code is (file:line) and what it does.
    • Glossary — every internal name (ticket, module, flag, acronym) in one
      phrase, under a Glossary / Глоссарий heading (or "Глоссарий: …").
    • Options — ONE real <table> with ≥2 option rows and filled pros/cons
      cells, or ONE <ul>/<ol> of ≥2 options (not bullets from the
      Recommendation / Where-to-look sections).
    • Recommendation — which option you'd pick and why (a heading alone with
      nothing under it does not count).
    • Where to look — a file:line in the TEXT (features/foo.ts:42, ./tg:1219,
      or a #L42 link). A bare path, "and/or", "12:30" do not count, and a
      --file/--photo attachment does not count either — write the file:line
      into the body.
  Plus STRUCTURE: each section under its own <h3>/<h4>, enumerations as short
  <ul>/<li> items (never inline "плюсы: a, b, c"), <hr> dividers between
  sections, short lines. Use --format html.

  GOOD (renders as a clean, scannable Rich Message):
    tg --tag decision --format html '<h3>Context</h3>
    <p>features/foo.ts:42 picks the click target; it misses on cold maps.</p><hr>
    <h3>Glossary</h3><ul><li>cold map — a map not yet rendered once</li></ul><hr>
    <h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>
    <tr><td>A</td><td>fast</td><td>risky</td></tr>
    <tr><td>B</td><td>safe</td><td>slow</td></tr></table><hr>
    <h3>Recommendation</h3><ul><li>A — faster, risk is contained</li></ul><hr>
    <h4>Where to look</h4><ul><li>features/foo.ts:42</li></ul>'

  BAD (blocked): a dense prose paragraph — "Надо решить A или B. Плюсы A: быстро,
  дешево; минусы: риск…" — no headings, no table/list, no dividers, one long
  run-on line. Hard to read; rejected.

  Escape hatch (genuine non-escalation / urgent edge case ONLY):
  ESCALATION_GATE_ENFORCE=0 downgrades the block to an advisory warning.

INTENT GATE (every agent-written message, tagged or NOT — tg-cli#706):
  tg reads the body itself, so a missing --tag no longer skips the format:
    • a question to the reader ("…?", "решай", "выбери", "let me know") is a
      decision request and needs the decision format above;
    • a problem (a blocker you need the human to clear: "блокер", "нет
      доступа", "blocked on") needs: Context prose; evidence / where to look
      (file:line, link, log, or the failing output in <code>/<pre>); the ask
      ("нужен доступ к …", "please grant …"); ≥2 <h3>/<h4> headings and <hr>;
    • a report of finished work ("готово", "смержил", "merged", "deployed")
      needs a reference (#123, ABC-123 or a URL) and verification (tests / CI /
      a live check); over 500 characters, headings or a list (or use
      tg report — tg help report).
  Outcomes:
    BLOCKED (exit 1, nothing sent, a list of what is missing): the message IS a
      malformed decision / problem / report, or it mixes a decision, a problem
      AND a report — send them separately.
    FOLLOW-UP REQUIRED (sent, exit 0): the message is a valid report /
      problem / answer that ALSO asks a question outside the decision format,
      carries several decisions, or hides a blocker in a report. tg prints and
      RECORDS one obligation per item: send each as its own reply,
        tg --reply-to <id> --tag decision --format html '…'
      A reply that passes the gate settles it; \`tg obligations\` lists what is
      still owed (--check exits 1 while any is open; dismiss <id> --reason …).
  Not gated: a sender with no agent identity (no agent process above it, no
  agent env marker — a cron job). --automated (a program-generated alert or
  digest) skips the problem/report formats; a prose question is still refused.
  laya (task-cli's local classifier) is consulted only through its already
  warm server (never loaded per message; TG_LAYA=0 off, TG_LAYA_TIMEOUT_MS,
  default 1200) and only adds a hint. ESCALATION_GATE_ENFORCE=0 downgrades a
  block to a warning. Iterate with --dry-run.

DICTIONARY GATE (banned wording, ALWAYS on, NO bypass flag):
  Every outgoing message — the --title, the body, and the caption of a
  --photo/--file, for every --tag and both formats, --dry-run included — is
  checked against the shared dictionary of banned words. A hit REFUSES the
  send (exit 1) and prints every match: the rule id, the matched text with
  ~20 chars of context, and the replacement to use. Rewrite the wording and
  resend; there is no flag or env var to skip it (only the human editing the
  file). The text is matched as the READER will see it: under --format html,
  text inside <code>…</code> / <pre>…</pre> is EXEMPT (quoting a banned word
  to discuss it is fine) and all other tags / entities are resolved before
  matching, so markup cannot hide a word; under plain format everything is
  literal text, so <code>…</code> exempts nothing there.

  File: ~/.claude/DICT.json (override the path with TG_DICT_PATH, in the
  environment or in ~/.config/tg-cli/.env).
    MISSING file   → the gate is silently off — at the DEFAULT path only; an
                     explicit TG_DICT_PATH that does not exist REFUSES to send
                     (it is a misconfiguration, not an off-switch).
    MALFORMED file (bad JSON, bad shape, a rule whose regex does not compile)
                   → a warning naming the file (and the rule) and NOTHING is
                     sent until it is fixed (fail closed).
  Format (JSON):
    {
      "version": 1,
      "rules": [
        {
          "id": "pochtit-as-fix",            // shown in the refusal
          "pattern": "\\\\bпочт(?:ил[аио]?|…)\\\\b", // a JS regex source, JSON-escaped
                                             //   (\\\\b in the file = regex \\b, which
                                             //   is Unicode-aware: works on Cyrillic)
          "flags": "iu",                     // optional; "u" is always added
          "only_if_cyrillic": true,          // optional: apply only when the
                                             //   message (title+body) has Cyrillic
          "replacement": "починил / починен", // printed on a hit
          "why": "There is no such verb."    // free text, for humans
        }
      ]
    }
`;

export function formatHelp(): string {
  return FORMAT_HELP;
}
