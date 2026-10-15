/**
 * @file The pre-send intent gate (tg-cli#706): what an outgoing message IS — a decision
 * ask, a problem (a blocker for the human), a report — whether or not it carries a
 * `--tag`, and whether each part follows its format.
 *
 * Accessed via: the `tg` entrypoint, on the final assembled body, after the content
 * guards and before `--dry-run` / the send. `classifyIntent` returns a verdict;
 * `formatIntentVerdict` turns it into the stderr text.
 *
 * WHY: the escalation-format gate (escalation-format.ts) only runs for
 * `--tag decision`. Agents that skip the tag sent bare prose questions ("Решай,
 * оставлять его или закрыть") straight to the CTO, and buried questions inside status
 * reports. This gate reads every body and decides by content.
 *
 * VERDICTS
 *   pass       nothing asked, or every part already in its format.
 *   follow-up  the message is sendable on its own (a report / problem / answer in its
 *              format), but it also asks something that is not a decision request, or
 *              it carries several decisions. It is sent; the entrypoint records one
 *              obligation per item — each must go out as its own `--reply-to` reply.
 *   block      the message IS a decision / problem / report and that part is malformed,
 *              or it mixes all three kinds. Exit 1 with the exact list of what is missing.
 *
 * DETECTION is deterministic and bilingual (RU/EN): a sentence of the sender's own prose
 * that ends in "?" or uses a decision imperative ("решай", "выбери", "let me know", …) is
 * an ask; quoted text (<pre>, <code>, <blockquote>, backticks) and URLs are not the
 * sender's prose. A narrow set of self-answered questions ("Почему упало? Флейк в …")
 * is not an ask. Problem and report kinds need explicit markers (a blocker phrase; a
 * completed-work verb), because a decision's own Context routinely mentions failures
 * and finished work. The optional laya probability (laya-socket.ts) is advisory only:
 * it can add a hint, never block or pass a message on its own.
 *
 * PURE — no I/O.
 */
import {
  decisionLabels,
  hasContextProse,
  hasFileRef,
  hasWallOfText,
  OPTIONS_HEADING_RE,
  splitSections,
  validateEscalationFormat,
} from './escalation-format';

export type IntentKind = 'decision' | 'problem' | 'report';

export interface FollowUp {
  kind: 'decision' | 'problem';
  // The sender's own words for the item (an ask sentence, a blocker sentence, or the
  // heading of one of several decisions), trimmed for display.
  quote: string;
}

export type BlockReason = 'malformed-decision' | 'malformed-problem' | 'malformed-report' | 'mixed';

export type IntentVerdict =
  // `valid`: the body is a decision request / a problem in its format — what a reply
  // under an owed follow-up of that kind settles.
  | { action: 'pass'; kinds: IntentKind[]; hints: string[]; valid?: 'decision' | 'problem' }
  | { action: 'follow-up'; kinds: IntentKind[]; reason: string; followUps: FollowUp[]; hints: string[] }
  | { action: 'block'; kinds: IntentKind[]; reason: BlockReason; detail: string[]; hints: string[] };

export interface IntentInput {
  body: string;
  // The validated lowercase `--tag`, if any.
  tag?: string;
  // `--automated`: a program-generated notification (a monitor alert, a scheduled
  // digest). The problem/report FORMAT checks are skipped; asks are still detected.
  automated?: boolean;
  // laya's P(the message asks the reader something), when the warm server answered.
  layaAskProbability?: number | null;
}

export interface IntentSignals {
  asks: string[];
  problems: string[];
  reports: string[];
}

// laya at or above this probability adds an advisory hint when the heuristic found no
// ask. Measured on the shipped checkpoints (tg-cli#706): non-asks stay well below it.
export const LAYA_ASK_THRESHOLD = 0.9;

// --- Prose extraction --------------------------------------------------------------

// Elements whose contents are not the sender's own prose: code, quotes, formulas.
const QUOTED_ELEMENT_RE = /<(pre|code|blockquote|aside|tg-math-block|tg-math)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/gu;
const INLINE_CODE_RE = /`[^`\n]+`/gu;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu;
const BLOCK_BREAK_RE =
  /<\/?(?:h[1-6]|p|tr|td|th|li|ul|ol|table|thead|tbody|tfoot|caption|details|summary|footer|figure|figcaption|div)\b[^>]*>|<(?:br|hr)\b[^>]*>/giu;
const TAG_RE = /<[^>]*>/gu;
const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
const ENTITY_RE = /&(#\d+|#x[\da-f]+|[a-z]+);/giu;

function decodeEntities(text: string): string {
  return text.replace(ENTITY_RE, (m, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)));
    return NAMED_ENTITIES[name.toLowerCase()] ?? m;
  });
}

// The sender's visible prose as lines of sentences: quoted/code text and URLs removed,
// block tags turned into line breaks, inline tags stripped, entities decoded.
function proseLines(body: string): string[][] {
  // The stripped text is only pattern-matched for asks/blockers, never rendered as HTML.
  const visible = decodeEntities(
    // codeql[js/incomplete-multi-character-sanitization]
    body
      .replace(QUOTED_ELEMENT_RE, ' ')
      .replace(FENCED_CODE_RE, ' ')
      .replace(INLINE_CODE_RE, ' ')
      .replace(URL_RE, ' ')
      .replace(BLOCK_BREAK_RE, '\n')
      .replace(TAG_RE, ''),
  );
  return visible
    .split(/\r?\n/u)
    .map((line) =>
      line
        .split(/(?<=[.!?…])\s+(?=\S)/u)
        .map((s) => s.trim())
        .filter((s) => /[\p{L}\p{N}]/u.test(s)),
    )
    .filter((sentences) => sentences.length > 0);
}

// --- Signals ----------------------------------------------------------------------

// A question mark closing a clause of words (not `tg#?`, not a lone "?").
const QUESTION_RE = /[\p{L}\p{N})»"'”\]]\s*\?+(?=[\s)»"'”\].,!…:;—–-]|$)/u;
// Not part of a word: JS `\b` is ASCII-only, so Cyrillic words use these instead.
const W = String.raw`(?<![\p{L}\p{N}])`;
const WE = String.raw`(?![\p{L}\p{N}])`;
// Decision imperatives / explicit requests for the reader's call, without a "?".
const DECISION_IMPERATIVE_RE = new RegExp(
  [
    `${W}(?:реши|решай|решите|выбери|выбирай|выберите|подтверди|подтвердите|одобри|одобрите|согласуй|согласуйте|определись|определитесь)${WE}`,
    `${W}да(?:й|йте) (?:знать|добро|ответ|отмашку|решение|ок)${WE}`,
    `${W}жду (?:твоего |вашего )?(?:решения|ответа|подтверждения|одобрения|отмашки|ок|добро)${WE}`,
    `${W}(?:нужно|нужен|нужна|нужны|требуется) (?:твоё|твое|ваше|твой|ваш|твоя|ваша) (?:решение|одобрение|подтверждение|ок|ответ|выбор|мнение)${WE}`,
    `${W}на (?:твоё|твое|ваше) усмотрение${WE}`,
    `${W}как (?:поступим|поступаем|быть)${WE}`,
    `${W}если (?:нет|не будет) возражений${WE}`,
    String.raw`\b(?:let me know|please (?:decide|confirm|choose|approve|advise)|your call|up to you|need your (?:decision|approval|ok|call|input)|waiting (?:for|on) your (?:decision|approval|answer|ok|go)|if (?:there are )?no objections|unless you object)\b`,
  ].join('|'),
  'iu',
);
// A question the sender answers in the very next sentence of the same line — a
// rhetorical device in reports ("Почему упало? Флейк в ctl-тестах."). Deliberately narrow:
// "Мержить или ждать? Я бы мержил." stays an ask.
const RHETORICAL_RE = new RegExp(
  `^(?:${W}(?:почему|зачем|из-за чего|в ч[её]м (?:причина|дело|проблема)|что (?:случилось|произошло|сломалось|было|изменилось|сделано|в итоге))${WE}|\\b(?:why|what (?:happened|broke|changed|was done)|root cause)\\b)`,
  'iu',
);
// A sentence that continues the previous ask ("Мержим? Или ждём?") — one decision.
const CONTINUATION_RE = new RegExp(`^${W}(?:или|либо)${WE}|^or\\b`, 'iu');
// A blocker the sender cannot clear alone. Explicit markers only (see the file header).
const PROBLEM_RE = new RegExp(
  [
    `${W}(?:блокер\\p{L}*|блокирует|заблокирован\\p{L}*|застрял\\p{L}*)${WE}`,
    `${W}не (?:могу|можем|получается) (?:продолжить|двигаться|закончить|выполнить|запустить|получить|задеплоить|смержить)${WE}`,
    `${W}нет доступа${WE}`,
    `${W}без (?:доступа|токена|прав|ключа|пароля) не${WE}`,
    `${W}нуж(?:ен|на|но|ны) (?:доступ|токен|ключ|пароль|права|твоя помощь|ваша помощь|помощь)${WE}`,
    `${W}требуется (?:доступ|токен|вмешательство|помощь)${WE}`,
    String.raw`\b(?:blocker|blocked (?:on|by)|i am blocked|i'm blocked|we are blocked|stuck on|cannot proceed|can't proceed|cannot continue|can't continue|need (?:your )?(?:access|a token|credentials|help))\b`,
  ].join('|'),
  'iu',
);
// Finished work: a completed-action verb or a results label.
const REPORT_RE = new RegExp(
  [
    `${W}(?:готово|сделано|выполнено|итоги?:|отч[её]т:)`,
    `${W}(?:сделал|выполнил|смержил|смерджил|замержил|задеплоил|выкатил|починил|исправил|закрыл|завершил|реализовал|добавил|запушил|опубликовал|выпустил)(?:а|и)?${WE}`,
    `${W}(?:смержен|смерджен|замержен|задеплоен|выкачен|починен|исправлен|закрыт|завершен|завершён|реализован|добавлен|выпущен)(?:а|о|ы)?${WE}`,
    String.raw`\b(?:done|merged|deployed|shipped|fixed|implemented|completed|finished|released|landed)\b`,
  ].join('|'),
  'iu',
);
// An explicitly absent blocker ("Блокера нет", "no blockers") is not a problem.
const NO_BLOCKER_RE = new RegExp(
  `${W}(?:блокер\\p{L}*\\s+нет|нет\\s+блокер\\p{L}*|без\\s+блокер\\p{L}*|ничего\\s+не\\s+блокирует|не\\s+заблокирован\\p{L}*|разблокирован\\p{L}*)${WE}|\\b(?:no\\s+blockers?|not\\s+blocked|nothing\\s+(?:is\\s+)?blocking|unblocked)\\b`,
  'iu',
);
// Unfinished work ("ещё не смержил", "not done yet") is not a report of finished work. Checked
// per clause (split at ; , — and "but"/"но"), so an unrelated negation elsewhere in the
// sentence ("I did not touch docs; implemented #706") does not hide the completion. "Not
// only" / "не только" adds to the work rather than negating it, so it is not a negation.
const NEGATED_RE = new RegExp(
  `${W}(?:не|пока не|ещё не|еще не)${WE}(?!\\s+только${WE})|\\b(?:not(?!\\s+only\\b)|never|yet)\\b|n't\\b`,
  'iu',
);
const CLAUSE_SPLIT_RE = new RegExp(`[;,—–]|${W}(?:но|а)${WE}|\\bbut\\b`, 'iu');

function clip(text: string): string {
  const t = text.replace(/\s+/gu, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

/** The asks, blocker sentences and finished-work sentences in the sender's prose. */
export function detectSignals(body: string): IntentSignals {
  const asks: string[] = [];
  const problems: string[] = [];
  const reports: string[] = [];
  for (const line of proseLines(body ?? '')) {
    let previousWasAsk = false;
    line.forEach((sentence, i) => {
      // Quoted speech («…», “…”, "…") is someone else's words: a question inside it is
      // reported, not asked ("Ты спросил «зачем X?» — отвечаю: …").
      const own = sentence.replace(/«[^«»]*»|“[^“”]*”|"[^"\n]*"/gu, ' ');
      const imperative = DECISION_IMPERATIVE_RE.test(own);
      const question = QUESTION_RE.test(own);
      const next = line[i + 1];
      const selfAnswered =
        question && !imperative && RHETORICAL_RE.test(own) && next !== undefined && !QUESTION_RE.test(next);
      if ((imperative || question) && !selfAnswered) {
        if (previousWasAsk && CONTINUATION_RE.test(sentence)) {
          asks[asks.length - 1] = clip(`${asks[asks.length - 1]} ${sentence}`);
        } else {
          asks.push(clip(sentence));
        }
        previousWasAsk = true;
        return;
      }
      previousWasAsk = false;
      if (PROBLEM_RE.test(own) && !NO_BLOCKER_RE.test(own)) problems.push(clip(sentence));
      else if (own.split(CLAUSE_SPLIT_RE).some((clause) => REPORT_RE.test(clause) && !NEGATED_RE.test(clause))) {
        reports.push(clip(sentence));
      }
    });
  }
  return { asks, problems, reports };
}

// --- Problem / report formats -----------------------------------------------------

export interface FormatCheck {
  ok: boolean;
  missing: string[];
}

const HEADING_RE = /<h[1-6]\b/giu;
const HR_RE = /<hr\b/iu;
const LINK_OR_LOG_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+|<(?:pre|code)\b|`[^`\n]+`|tg#\d+|(?:^|\s)(?:~|\.{0,2})\/[\w.-]+\/[\w./-]+/iu;
// What the sender needs from the human to get unblocked.
const NEED_RE = new RegExp(
  `${W}(?:нуж(?:ен|на|но|ны)|прошу|просьба|требуется|дай|дайте|дашь|дадите|выдай|выдайте|выдашь|выдадите|предоставь|предоставьте|предоставишь|разреши|разрешите|разрешишь|разблокируй|сделай|сделайте|сделаешь|добавь|добавьте|добавишь|можешь|можете|сможешь|сможете)${WE}|\\b(?:need|please|requires? your|grant|unblock|could you|can you)\\b`,
  'iu',
);

/**
 * The problem format: a problem is an escalation to unblock the sender
 * (decision-request-discipline: "A blocker that needs the human to unblock you goes out as
 * `tg --tag problem` — the same structure applies to it"). Context, evidence, the ask, and
 * the same Rich Message structure as a decision. A choice inside a problem is a decision.
 */
export function validateProblemFormat(body: string): FormatCheck {
  const text = body ?? '';
  const missing: string[] = [];
  if (!hasContextProse(text)) missing.push('Context — a sentence of prose: what you were doing and what is blocked');
  if (!hasFileRef(text) && !LINK_OR_LOG_RE.test(text)) {
    missing.push('Evidence / where to look — a file:line, a link, a log path, or the failing command/output in <code>/<pre>');
  }
  // Matched only, never rendered as HTML.
  // codeql[js/incomplete-multi-character-sanitization]
  if (!NEED_RE.test(text.replace(TAG_RE, ' '))) {
    missing.push('The ask — what exactly you need from the human to get unblocked ("нужен доступ к …", "please grant …")');
  }
  if ((text.match(HEADING_RE) ?? []).length < 2) {
    missing.push('Structure — each section under its own <h3>/<h4> heading (needs --format html; ≥2 headings)');
  }
  if (!HR_RE.test(text)) missing.push('Structure — separate sections with <hr> dividers');
  if (hasWallOfText(text)) missing.push('Readability — short lines, one idea per bullet (no long dense paragraph)');
  return { ok: missing.length === 0, missing };
}

const REFERENCE_RE = /(?<![\p{L}\p{N}&#])#\d+|\b[A-Z][A-Z0-9]{1,9}-\d+\b|\bhttps?:\/\/\S+|\btg#\d+/u;
const VERIFY_RE = new RegExp(
  `${W}(?:тест\\p{L}*|провер\\p{L}*|зел[её]н\\p{L}*|прош[её]л|прошли|прошло|сборк\\p{L}*|ревью|линт\\p{L}*)${WE}|\\b(?:tests?|CI|green|pass(?:ed|es|ing)?|verif\\w*|smoke|e2e|review(?:ed)?|lint|typecheck|exit 0)\\b|<pre\\b`,
  'iu',
);
const MARKDOWN_LIST_LINE_RE = /^\s*(?:[-•*]|\d+[.)])\s+\S/u;
const LONG_REPORT_CHARS = 500;

/**
 * The report format, derived from `tg report` (features/cli/report.ts): what it is about
 * (a ticket / PR / link), proof it was verified, and visible structure once it is long.
 */
export function validateReportFormat(body: string): FormatCheck {
  const text = body ?? '';
  // Measured and matched only, never rendered as HTML.
  // codeql[js/incomplete-multi-character-sanitization]
  const visible = decodeEntities(text.replace(TAG_RE, ''));
  const missing: string[] = [];
  if (!REFERENCE_RE.test(visible) && !/<a\s[^>]*href=/iu.test(text)) {
    missing.push('Reference — the ticket / PR / commit link the report is about (#123, ABC-123 or a URL)');
  }
  if (!VERIFY_RE.test(text)) {
    missing.push('Verification — what you ran or checked and its result (tests / CI / live check)');
  }
  const listLines = visible.split('\n').filter((l) => MARKDOWN_LIST_LINE_RE.test(l)).length;
  const structured = (text.match(HEADING_RE) ?? []).length >= 2 || /<(?:ul|ol|li)\b/iu.test(text) || listLines >= 2;
  if (visible.length > LONG_REPORT_CHARS && !structured) {
    missing.push(`Structure — a report over ${LONG_REPORT_CHARS} characters needs headings or a list`);
  }
  return { ok: missing.length === 0, missing };
}

// --- Classification ---------------------------------------------------------------

const PRIMARY_TAGS: Record<string, IntentKind> = { decision: 'decision', problem: 'problem', report: 'report' };
// The sections of a decision request a question legitimately sits in: the Options section
// exactly as validateEscalationFormat recognises it (OPTIONS_HEADING_RE — "Предлагаемые
// варианты" included), or a heading that is WHOLLY one of the other part names, after an
// optional "1." / "2)" numbering and before an optional ": topic". So "1. Context" is a
// decision part; "Background checks" and "Decision appendix" are not.
const DECISION_PART_NAME_RE = new RegExp(
  `^(?:\\d+[.)]?\\s*)?(?:context|background|problem|question|issue|decision|recommendations?|` +
    `контекст|проблема|вопрос|решение|рекомендаци[яи])` +
    `(?:\\s*\\d+)?(?:\\s*[:.—–-].*)?$`,
  'iu',
);

/** Whether asking laya can change anything: only a body the heuristic found no ask in. */
export function layaWorthAsking(input: IntentInput): boolean {
  if (input.automated || input.tag === 'decision') return false;
  // Measured only, never rendered as HTML.
  // codeql[js/incomplete-multi-character-sanitization]
  if (decodeEntities(input.body.replace(TAG_RE, '')).trim().length < 40) return false;
  return detectSignals(input.body).asks.length === 0;
}

export function classifyIntent(input: IntentInput): IntentVerdict {
  const body = input.body ?? '';
  const { tag } = input;
  const sig = detectSignals(body);
  const kinds: IntentKind[] = [];
  if (sig.asks.length > 0 || tag === 'decision') kinds.push('decision');
  if (sig.problems.length > 0 || tag === 'problem') kinds.push('problem');
  if (sig.reports.length > 0 || tag === 'report') kinds.push('report');

  const hints: string[] = [];
  const laya = input.layaAskProbability;
  if (sig.asks.length === 0 && typeof laya === 'number' && laya >= LAYA_ASK_THRESHOLD) {
    hints.push(
      `laya reads this message as asking the reader something (p=${laya.toFixed(2)}), but no question sentence was found. ` +
        'If it does ask, send that question as its own --tag decision message.',
    );
  }

  // A decision request already in its format — asked in so many words or not: the rest
  // of the body is its context (a decision's Context routinely names failures and done work).
  // A question under a heading that is not part of the decision (Where to look, Glossary,
  // an unrelated heading) — or before the first heading, outside every section the format
  // defines — is a second ask riding along, owed as its own message.
  const decision = validateEscalationFormat(body);
  if (decision.ok) {
    if (!kinds.includes('decision')) kinds.unshift('decision');
    const labels = decisionLabels(body);
    const extraAsks = splitSections(body)
      .filter((s) => s.heading === '' || (!OPTIONS_HEADING_RE.test(s.heading) && !DECISION_PART_NAME_RE.test(s.heading)))
      .flatMap((s) => detectSignals(s.body).asks);
    if (labels.length > 1 || extraAsks.length > 0) {
      return {
        action: 'follow-up',
        kinds,
        reason: [
          labels.length > 1 ? `this message carries ${labels.length} separate decisions — each one needs its own message` : '',
          extraAsks.length > 0 ? 'it also asks a question outside its decision request' : '',
        ]
          .filter(Boolean)
          .join('; '),
        followUps: [
          ...(labels.length > 1 ? labels.map((quote): FollowUp => ({ kind: 'decision', quote })) : []),
          ...extraAsks.map((quote): FollowUp => ({ kind: 'decision', quote })),
        ],
        hints,
      };
    }
    if (tag !== 'decision') hints.push('This is a decision request: send it with --tag decision.');
    // A program's message (--automated) never settles an agent's owed follow-up.
    return input.automated ? { action: 'pass', kinds, hints } : { action: 'pass', kinds, hints, valid: 'decision' };
  }

  if (kinds.length === 3) {
    return {
      action: 'block',
      kinds,
      reason: 'mixed',
      detail: [
        `decision: «${sig.asks[0] ?? '(tagged)'}»`,
        `problem: «${sig.problems[0] ?? '(tagged)'}»`,
        `report: «${sig.reports[0] ?? '(tagged)'}»`,
      ],
      hints,
    };
  }

  // Untagged: a report is the sendable carrier; a blocker whose only questions are its
  // own requests ("дашь доступ?") is a problem; any other question makes it a decision.
  const requestsOnly = sig.asks.every((q) => NEED_RE.test(q));
  const primary: IntentKind | 'answer' | null =
    (tag !== undefined ? PRIMARY_TAGS[tag] : undefined) ??
    (tag === 'answer'
      ? 'answer'
      : kinds.includes('report')
        ? 'report'
        : kinds.includes('problem') && requestsOnly
          ? 'problem'
          : kinds.includes('decision')
            ? 'decision'
            : null);
  if (primary === null) return { action: 'pass', kinds, hints };

  const asks: FollowUp[] = sig.asks.map((quote) => ({ kind: 'decision', quote }));
  if (primary === 'answer' && asks.length === 0) return { action: 'pass', kinds, hints };

  // An answer that is nothing but a question back is a bare decision ask; an answer
  // with real content of its own is sendable and owes the question as a follow-up.
  const answerProse = proseLines(body)
    .flat()
    .filter((s) => !sig.asks.some((q) => q.includes(clip(s)) || clip(s).includes(q)))
    .join(' ');
  const bareQuestion = primary === 'answer' && (answerProse.match(/[\p{L}\p{N}]/gu) ?? []).length < 20;
  if (primary === 'decision' || bareQuestion) {
    return {
      action: 'block',
      kinds,
      reason: 'malformed-decision',
      detail: [
        ...sig.asks.map((q) => `ask: «${q}»`),
        ...(asks.length > 1 ? [`It asks ${asks.length} separate questions — each one is its own decision message.`] : []),
        ...decision.missing,
      ],
      hints,
    };
  }

  const check =
    input.automated || primary === 'answer'
      ? { ok: true, missing: [] }
      : primary === 'problem'
        ? validateProblemFormat(body)
        : validateReportFormat(body);
  // A problem's own request ("дашь доступ к staging?") is its ask, not a separate decision.
  const choiceAsks = primary === 'problem' ? asks.filter((a) => !NEED_RE.test(a.quote)) : asks;
  if (!check.ok) {
    return {
      action: 'block',
      kinds,
      reason: primary === 'problem' ? 'malformed-problem' : 'malformed-report',
      detail: [
        ...check.missing,
        ...choiceAsks.map((a) => `and the question «${a.quote}» goes out as its own --tag decision message`),
      ],
      hints,
    };
  }
  // A blocker hidden in a report is its own problem message; inside a problem it is the point.
  const followUps = [
    ...choiceAsks,
    ...(primary === 'report' ? sig.problems.map((quote): FollowUp => ({ kind: 'problem', quote })) : []),
  ];
  if (followUps.length === 0) {
    return primary === 'problem' && !input.automated ? { action: 'pass', kinds, hints, valid: 'problem' } : { action: 'pass', kinds, hints };
  }
  return {
    action: 'follow-up',
    kinds,
    reason:
      choiceAsks.length === 0
        ? `this ${primary} also reports a blocker — the blocker is its own --tag problem message`
        : choiceAsks.length === 1
          ? 'this message asks a question that is not a decision request'
          : `this message asks ${choiceAsks.length} questions that are not decision requests`,
    followUps,
    hints,
  };
}

// --- Rendering --------------------------------------------------------------------

const DECISION_SKELETON =
  "'<h3>Context</h3><p>…</p><hr><h3>Glossary</h3><ul><li>…</li></ul><hr>" +
  '<h3>Options</h3><table><tr><th>Option</th><th>Pros</th><th>Cons</th></tr>…</table><hr>' +
  "<h3>Recommendation</h3><ul><li>…</li></ul><hr><h3>Where to look</h3><ul><li>file.ts:42</li></ul>'";
const PROBLEM_SKELETON =
  "'<h3>Context</h3><p>…</p><hr><h3>What is blocked</h3><ul><li>…</li></ul><hr>" +
  "<h3>What I need from you</h3><ul><li>…</li></ul><hr><h3>Where to look</h3><ul><li>file.ts:42 / log / link</li></ul>'";

const REASON_HEADLINE: Record<BlockReason, string> = {
  'malformed-decision':
    'this message asks the reader to decide, but it is not in the decision-request format (skill: decision-request-discipline)',
  'malformed-problem':
    'this problem (a blocker for the human) is not in the problem format (skill: decision-request-discipline)',
  'malformed-report': 'this report is not in the report format (tg help report)',
  mixed: 'this message mixes a decision, a problem and a report — send them as separate messages',
};

/** The reply command for one follow-up, with the original's id when it is known. */
export function followUpCommand(item: FollowUp, originalId?: number): string {
  const ref = originalId === undefined ? '<id of this message>' : String(originalId);
  return item.kind === 'decision'
    ? `tg --reply-to ${ref} --tag decision --format html ${DECISION_SKELETON}`
    : `tg --reply-to ${ref} --tag problem --format html ${PROBLEM_SKELETON}`;
}

/** The stderr text for a verdict. `originalId` is the sent message's id (follow-ups). */
export function formatIntentVerdict(verdict: IntentVerdict, originalId?: number): string {
  const hints = verdict.hints.map((h) => `tg: hint: ${h}`);
  if (verdict.action === 'pass') return hints.join('\n');
  if (verdict.action === 'block') {
    return [
      `tg: intent gate: BLOCKED — ${REASON_HEADLINE[verdict.reason]}.`,
      'Fix:',
      ...verdict.detail.map((d) => `  • ${d}`),
      verdict.reason === 'malformed-problem'
        ? `Shape: tg --tag problem --format html ${PROBLEM_SKELETON}`
        : verdict.reason === 'malformed-report'
          ? 'Shape: tg report --title … --ticket … --impact … --verify-cmd … --verify-result …  (tg help report)'
          : verdict.reason === 'mixed'
            ? 'Send the report, the problem and each decision as their own messages (decision: --tag decision, problem: --tag problem, report: tg report).'
            : `Shape: tg --tag decision --format html ${DECISION_SKELETON}  (tg help format)`,
      ...hints,
    ].join('\n');
  }
  return [
    `tg: intent gate: FOLLOW-UP REQUIRED — ${verdict.reason}.`,
    `Send ${verdict.followUps.length === 1 ? 'it' : `each of the ${verdict.followUps.length}`} as a REPLY to this message, one message per item, in its format:`,
    ...verdict.followUps.map((f, i) => `  ${i + 1}. [${f.kind}] «${f.quote}»\n     ${followUpCommand(f, originalId)}`),
    ...hints,
  ].join('\n');
}
