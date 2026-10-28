/** Required content of a problem report (tg#25035, tg#25331; tg-cli#800).
 *
 * A report describes an action already taken AND its observed result, plus the concrete
 * recovery step being attempted now. An honest external blocker names the dependency and
 * the check to run once it clears. The validator never supplies or invents these facts.
 * Labels help the offline fallback; headings alone, promises and passive monitoring do not.
 * PURE: no I/O. Used by the intent gate and the existing warm Laya socket adapter.
 */
import { splitSections } from './escalation-format';

export type ProblemLayaAssessment =
  | { status: 'ok'; done: number; current: number }
  | { status: 'unavailable'; reason: 'disabled' | 'no-socket' | 'timeout' | 'connection-error' | 'invalid-response' | 'payload-too-large' }
  | { status: 'skipped'; reason: 'dry-run' };

const DONE_LABEL = /^(?:(?:what (?:i|we) (?:already )?(?:did|tried))|already (?:done|tried)|actions taken|tried|уже (?:сделал[аи]?|сделано|проверил[аи]?)|что (?:уже )?(?:сделал[аи]?|сделано|предпринято)|предпринято|попытки)$/iu;
const RESULT_LABEL = /^(?:results?|observed results?|outcomes?|результат(?:ы)?|наблюдаемый результат)$/iu;
const CURRENT_LABEL = /^(?:doing now|trying now|currently trying|current (?:action|remediation|attempt)|what (?:i am|we are) doing now|now|сейчас(?: (?:делаю|делаем|пробую|предпринимаю))?|что (?:делаю|делаем|пытаюсь) сейчас|текущие действия)$/iu;
const WORD_START = String.raw`(?<![\p{L}\p{N}])`;
const WORD_END = String.raw`(?![\p{L}\p{N}])`;
const PAST = new RegExp(`${WORD_START}(?:(?:проверил|запустил|повторил|запросил|открыл|перезапустил|прочитал|посмотрел|сверил|протестировал|попробовал|выполнил|перечислил|наш[её]л|собрал|отправил|восстановил|изолировал|проверял|смотрел|запускал|пробовал|откатил|исправил|починил|переключил|диагностировал|воспроизв[её]л)(?:а|и)?|попытал(?:ся|ась|ись)|нашла|нашли)${WORD_END}|\\b(?:checked|ran|reran|retried|requested|opened|restarted|rebooted|read|inspected|tested|tried|attempted|executed|listed|searched|queried|compared|collected|sent|restored|isolated|verified|fixed|deployed|pinged|debugged|reproduced|examined|reviewed|fetched|curled|patched|switched|rolled back)\\b`, 'giu');
const CURRENT = new RegExp(`${WORD_START}(?:проверяю|проверяем|открываю|открываем|повторяю|повторяем|запускаю|запускаем|восстанавливаю|восстанавливаем|изолирую|тестирую|анализирую|запрашиваю|запрашиваем|сверяю|исправляю|чиню|чиним|перезапускаю|собираю|ищу|ищем|читаю|читаем|меняю|меняем|подключаюсь|подключаемся|перенастраиваю|перенастраиваем|пробую|пробуем|пытаюсь|пытаемся|смотрю|смотрим|откатываю|откатываем|разбираюсь|разбираемся|диагностирую|диагностируем|обновляю|обновляем|переключаю|переключаем|перепроверяю|устраняю|настраиваю|исследую|воспроизвожу|пересоздаю|пересоздаём|перезагружаю|сбрасываю|очищаю|переподключаю|устанавливаю)${WORD_END}|\\b(?:checking|(?:re-?)?opening|retrying|running|rerunning|restoring|isolating|testing|analysing|analyzing|requesting|comparing|fixing|restarting|collecting|searching|verifying|reading|changing|connecting|inspecting|reconfiguring|investigating|debugging|rebuilding|rolling back|deploying|trying|examining|reproducing|patching|updating|reviewing|fetching|pinging|diagnosing|switching|reloading|(?:re-?)?creating|rotating|reconnecting|reinstalling|reverting|clearing|resetting|killing)\\b`, 'giu');
// An English marker that is one dotted component of a file name (output.log, result.json) names a target.
const RESULT = new RegExp(`${WORD_START}(?:результат|получил[аи]?|увидел[аи]?|обнаружил[аи]?|вернул[аои]?|показал[аои]?|ответ|вывод|завершил(?:ся|ась|ось|ись))${WORD_END}|(?<![\\p{L}\\p{N}_][./-])\\b(?:result|observed|received|returned|responded|found|output|exit(?:ed)?|failed)\\b(?![./-][\\p{L}\\p{N}_])`, 'giu');
// "still"/"всё ещё" alone describe a state of mind, not an observation: not enough without a result marker.
const RESULT_FACT = /отсутствует|не найден|недоступ|запрещ|ошибк|таймаут|\b(?:absent|missing|denied|unavailable|timeout|timed out|error|failed|\d{3})\b/iu;
// An observed result that is itself a deferral or a promise has not been observed.
const RESULT_DEFERRED = /^\s*[:—-]?\s*(?:(?:still|we|i|it|is|are|be|being|currently|мы|я|пока|ещё|еще)\s+){0,3}(?:investigating|узнаю|будет|будут|позже|потом|later|tbd|не\s+(?:известн\p{L}*|знаем|знаю)|(?:unknown|pending|n\/a|неизвестн\p{L}*)\s*(?:[.,;:)]|$)|(?:will|would|shall)(?!\s+not\b)|to\s+be|not\s+(?:yet\s+)?(?:known|determined))(?![\p{L}\p{N}])/iu;
// Words that never name a target or a result ("checking the situation" names nothing).
const VAGUE = /^(?:проверил[аи]?|попробовал[аи]?|наблюдаю|проверяю|слежу|делаю|ситуаци\p{L}*|проблем\p{L}*|результат|неизвест\p{L}*|позже|потом|пока|дальше|работаю|вопрос|это|этим|всё|все|для|что|как|или|при|checked|tried|monitoring|watching|working|issue|problem|situation|result|unknown|pending|later|it|this|the|and|for|with|that|was|are|not|its|any|all)$/iu;

/** Labels describe a field; "Уже сделал" alone does not report completed work. */
export function withoutRemediationLabel(text: string): string {
  const colon = text.search(/[:：]/u);
  const label = (colon < 0 ? text : text.slice(0, colon)).trim();
  return DONE_LABEL.test(label) || CURRENT_LABEL.test(label) ? (colon < 0 ? '' : text.slice(colon + 1)) : text;
}

function ownText(body: string): string {
  // Decode quote entities before excluding quotations, including numeric forms. This
  // is text analysis only; decoded text is never rendered back into HTML.
  const quotes: Record<string, string> = { quot: '"', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”' };
  return body.replace(/&(#x[\da-f]+|#\d+|quot|laquo|raquo|ldquo|rdquo);/giu, (entity, value: string) => {
      if (!value.startsWith('#')) return quotes[value.toLowerCase()] ?? entity;
      const cp = /^#x/iu.test(value) ? Number.parseInt(value.slice(2), 16) : Number(value.slice(1));
      return [34, 171, 187, 8220, 8221].includes(cp) ? String.fromCodePoint(cp) : entity;
    })
    .replace(/<(blockquote|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, ' ')
    .replace(/^\s*>.*$/gmu, ' ')
    // Keep quoted command/output text as literal evidence, but never as author verbs.
    // The tag alternative leaves attribute quotes alone; encoded angles keep quoted
    // example headings from opening real sections in splitSections.
    .replace(/<[^>]*>|«[^«»]*»|“[^“”]*”|"[^"]*"/gu, (part) => part.startsWith('<') ? part :
      `<code>${part.slice(1, -1).replace(/</gu, '&lt;').replace(/>/gu, '&gt;')}</code>`);
}

const TEXT_ENTITIES: Record<string, string> = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode a visible text span once; malformed references must not join action words. */
function decodeTextEntities(text: string): string {
  return text.replace(/&(#(?:[xX][\da-fA-F]+|\d+)|nbsp|amp|lt|gt|quot|apos);/gu, (entity, value: string) => {
    if (!value.startsWith('#')) return TEXT_ENTITIES[value] ?? entity;
    const cp = /^#x/iu.test(value) ? Number.parseInt(value.slice(2), 16) : Number(value.slice(1));
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : entity;
  });
}

function plain(body: string): string {
  // Recognize actual markup before decoding each text span. Decoded angles cannot
  // create tags/sections, and an encoded ampersand cannot start another decoding pass.
  // codeql[js/incomplete-multi-character-sanitization] False positive: classification-only text
  // normalization. The output is only matched against verb/evidence patterns and is never emitted as HTML, so
  // a leftover '<script' has no sink. See tests/problem-remediation.test.ts.
  return body.replace(/<(pre|code)\b[^>]*>([\s\S]*?)<\/\1\s*>|<\/?(p|li|ul|ol|div|br|hr)\b[^>]*>|<[^>]*>|[^<]+/giu,
    (part, literal: string | undefined, inner: string | undefined, block: string | undefined) => {
      // Keep command/output evidence inside a literal boundary. Encoded backticks
      // inside <code>/<pre> must not close that boundary and expose example verbs.
      // codeql[js/incomplete-multi-character-sanitization] False positive: classification-only; the stripped
      // text becomes a backtick-delimited literal for evidence matching and is never emitted as HTML.
      if (literal) return `\`${decodeTextEntities(inner!.replace(/<[^>]*>/gu, '')).replace(/`/gu, '')}\``;
      if (block) return '\n';
      return part.startsWith('<') ? '' : decodeTextEntities(part);
    }).trim();
}

export interface ProblemEvidence { done: string; current: string; currentLabel: boolean; doneLabel: boolean }

interface EvidenceSinks { done: string[]; current: string[] }

const LABELLED_LINE = /^\s*(?:[-•*]\s*)?([^:：]{2,70})[:：]\s*(.*)$/u;

function sinkFor(label: string, sinks: EvidenceSinks): string[] | null {
  if (DONE_LABEL.test(label)) return sinks.done;
  return CURRENT_LABEL.test(label) ? sinks.current : null;
}

/** Route the "Already tried: …" / "Doing now: …" lines of one section, plus their continuation
 * lines, to their sinks. Labels inside a literal span are text, not fields. Returns the sink the
 * last label left active. */
function routeLabelledLines(content: string, sinks: EvidenceSinks): string[] | null {
  let active: string[] | null = null;
  let inLiteral = false;
  for (const line of content.split('\n')) {
    const match = inLiteral ? null : LABELLED_LINE.exec(line);
    if (line.split('`').length % 2 === 0) inLiteral = !inLiteral;
    const sink = match && sinkFor(match[1].trim(), sinks);
    if (match && sink) { active = sink; active.push(match[2]); }
    else if (active) active.push(line);
  }
  return active;
}

/** Select full action sections, including ones far beyond the old 2000-character head. */
export function problemRemediationEvidence(body: string): ProblemEvidence {
  const sinks: EvidenceSinks = { done: [], current: [] };
  const all: string[] = [];
  let associateResult = false;
  for (const section of splitSections(ownText(body ?? ''))) {
    const heading = plain(section.heading).replace(/[:：]\s*$/u, '').trim();
    const content = plain(section.body);
    all.push(content);
    const doneHeading = DONE_LABEL.test(heading);
    // A result may have its own heading. Preserve the author's actual result label
    // together with its content for BOTH the deterministic check and Laya extraction.
    if (doneHeading || (associateResult && RESULT_LABEL.test(heading))) {
      sinks.done.push(doneHeading ? content : `${heading}: ${content}`);
      associateResult = true;
      continue;
    }
    associateResult = false;
    if (CURRENT_LABEL.test(heading)) { sinks.current.push(content); continue; }
    associateResult = routeLabelledLines(content, sinks) === sinks.done;
  }
  const prose = all.join('\n');
  const { done, current } = sinks;
  return { done: done.length ? done.join('\n') : prose, current: current.length ? current.join('\n') : prose, currentLabel: current.length > 0, doneLabel: done.length > 0 };
}

/** A target or result is concrete when it names at least one thing (not a filler word). */
function concrete(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? [];
  return words.some((word) => word.length > 2 && !VAGUE.test(word));
}

const UNREAL = /\b(?:not(?!\s+only\b)|never|will|would|shall|should|could|might|may(?=\s+(?:be|not|have|also|still|just)\b)|if|unless|whether|(?:i|we)\s+plan(?:ning)?|plan(?:ning|s|ned)?\s+(?:on|to)|intend(?:ing|s|ed)?|going to|no longer|(?:want|need|hope)(?:s|ed)? to)\b|(?<=\p{L})n['’]t\b|\b(?:i|we|you|they|it|he|she|that|there)['’]ll\b|(?:^|\s)(?:не(?!\s+только)|если|буду|будем|собираюсь|планирую|намерен|никогда|нельзя|хочу|хотим|надо|нужно|должен|должна|должны|смогу|сможем|пока не|ещё не|еще не)(?![\p{L}\p{N}])/iu;
const STOPPED = /\b(?:was|were|had been|stopped|finished|ceased|paused|quit|abandoned)\b|(?:^|\s)(?:перестал[аи]?|прекратил[аи]?|закончил[аи]?|завершил[аи]?|приостановил[аи]?)(?![\p{L}\p{N}])/iu;

// Analysis windows. A clause, a target or a result never spans thousands of characters; bounding
// each scan keeps validation linear in the body size even for verb-dense log pastes.
const CLAUSE_LOOKBACK = 1000;
const CLAUSE_LOOKAHEAD = 400;
const RESULT_LOOKAHEAD = 1500;
const TARGET_LOOKBACK = 300;
const RESULT_MARKERS_TRIED = 3;

const SENTENCE_END = /[!?;]|\.(?![\p{L}\p{N}_])/gu;
// A conditional OPENER ("If it works, checking X") governs its whole line, comma or not; one inside an
// adjunct ("To check if X, I curled Y") does not reach the main clause.
const CONDITIONAL_OPENER = /^\s*(?:if|unless|whether|если)(?![\p{L}\p{N}])/iu;
// A conjunction opens a new clause ("not checking X but fixing Y", "X failed so I restarted").
// Sentence punctuation and commas/dashes/parentheses are handled around it; a dot inside a
// file name (output.log) ends nothing.
const CONJUNCTION = /(?<![\p{L}\p{N}])(?:but|so|because|since|while|whereas|however|though|although|но|поэтому|однако|потому что|так как)(?![\p{L}\p{N}])/giu;
// A subordinate adjunct set off by commas: "I won't, since approval is missing, be restarting".
const SUBORDINATE = /^\s*(?:because|since|while|whereas|though|although|as|when|after|before|так как|потому что|пока|когда)(?![\p{L}\p{N}])/iu;

// A line ends mid-clause when its last words are a negation/future/stop marker (plus
// filler such as "currently" or "yet started"): "I am not<br>checking". A line that merely
// contains a negation but ends in other words ("is still not known") is a separate statement.
const NEGATION_MARKER = String.raw`(?:(?<!\bor\s)not|never|will|would|shall|should|could|might|if|unless|whether|no\s+longer|\p{L}+n['’]t|(?:i|we|you|they|it|he|she|that|there)['’]ll|(?:want|need|hope)(?:s|ed)?\s+to|(?:i|we)\s+plan(?:ning)?|plan(?:ning|s|ned)?\s+(?:on|to)|intend(?:ing|s|ed)?(?:\s+to)?|going(?:\s+to)?|не|если|буду|будем|собираюсь|планирую|намерен|никогда|нельзя|хочу|хотим|надо|нужно|должен|должна|должны|смогу|сможем)`;
const STOP_MARKER = String.raw`(?:was|were|had\s+been|stopped|finished|ceased|paused|quit|abandoned|перестал[аи]?|прекратил[аи]?|закончил[аи]?|завершил[аи]?|приостановил[аи]?)`;
// Belief verbs ("I don't think we ...", «не думаю, что мы ...») keep a negation open across the pronoun.
const WRAP_FILLER = String.raw`(?:\p{L}+ly|yet|be|being|now|just|started|starting|begun|even|still|also|already|think|believe|suppose|expect|claim|that|сейчас|пока|ещё|еще|уже|вообще|думаю|считаю|полагаю|верю|что)`;
// "I'm not sure I restarted", "It is not true that we ...": doubt before a new subject keeps the negation.
const DOUBT_FILLER = String.raw`(?:${WRAP_FILLER}|sure|certain|true|clear|convinced|aware|уверен\p{L}*|точно)`;
// Across a blank line (a paragraph or list item) only an unfinished negation/future still binds.
const wrapTail = (marker: string, filler: string): RegExp =>
  new RegExp(`(?:^|[\\s,])${marker}(?:\\s+${filler})*\\s*$|^\\s*${filler}(?:\\s+${filler})*\\s*$`, 'iu');
const WRAPPED_LINE = wrapTail(`(?:${NEGATION_MARKER}|${STOP_MARKER})`, WRAP_FILLER);
const WRAPPED_NEGATION = wrapTail(NEGATION_MARKER, WRAP_FILLER);
const NEGATION_BEFORE_SUBJECT = wrapTail(NEGATION_MARKER, DOUBT_FILLER);
const LIST_OR_LABEL = /^\s*(?:[-•*]|\d+[.)])\s|^\s*[^:：]{2,70}[:：](?:\s|$)/u;
const NEW_SUBJECT = /(?<![\p{L}\p{N}])(?:i|we|я|мы)(?![\p{L}\p{N}'’])/iu;
const NEW_SUBJECTS = new RegExp(NEW_SUBJECT.source, 'giu');
// The rest of a current action's own clause. A following verification ("and then I will
// verify") is a separate clause, and so is a restrictive clause about the target ("the job that
// runs tomorrow", "whether it will start"); a non-restrictive ", which I will finish tomorrow" is not.
const CURRENT_AFTER_END = /;|\n|[.!?](?:\s|$)|\bbut\b|\bso\b|\b(?:and\s+)?then\b|\band\s+(?:next|afterwards?|finally|i|we)\b|\b(?:that|whether|if|when|where|who|until)\b|(?<!,\s*)\bwhich\b|(?:^|\s)(?:и затем|а затем|затем|следующая проверка|который|которая|которое|которые|если|когда|чтобы|пока)(?![\p{L}\p{N}])/iu;
// "completed/stopped" only describes the action itself when it directly follows it; a relative
// clause ("the worker that was stopped by OOM") is part of the target.
const FUTURE_AFTER = /\b(?:will|would|shall)\b|^\s*(?:is|are|was|were|has been|have been)\s+(?:completed|finished|stopped|paused)\b|\b(?:is|are|was|were|has been|have been)\s+(?:scheduled|planned|intended)\b|\b(?:tomorrow|tonight)\b|\blater(?:\s+(?:today|on|this)\b|\s*$)|\bnext\s+(?:week|month|day|hour|morning|year)\b|\bin\s+\d+\s+(?:minutes?|mins?|hours?|days?)\b|(?:^|\s)(?:завтра|вечером|на следующей неделе)(?![\p{L}\p{N}])|(?:^|\s)(?:позже|потом)(?:\s*$|\s+(?:сегодня|в)(?![\p{L}\p{N}]))|через\s+\d+\s+(?:минут\p{L}*|мин|час\p{L}*|дн\p{L}*|секунд\p{L}*)/iu;

/** The clause part of a line. A comma, dash or parenthesis ends a clause ("Since X did not help,
 * restarting"), except after a dangling negation, directly or around a short or subordinate
 * parenthetical: "I am not, for now, checking", "I won't, since approval is missing, be restarting". */
function lastCommaClause(line: string): string {
  const parts = line.split(/[,()—–]/u);
  let clause = parts.pop()!.split(CONJUNCTION).at(-1)!;
  while (parts.length > 0) {
    const previous = parts.pop()!;
    const parenthetical = parts.length > 0 && (previous.trim().split(/\s+/u).length <= 3 || SUBORDINATE.test(previous)) && WRAPPED_LINE.test(parts.at(-1)!);
    if (!WRAPPED_LINE.test(previous.split(CONJUNCTION).at(-1)!) && !parenthetical) break;
    clause = `${previous} ${clause}`;
  }
  return clause;
}

/** The clause an action word sits in. A newline/<br> continues the clause only when the
 * previous line stops on a dangling marker; sentence punctuation, list items and labelled
 * fields always end it, so independent lines never lend each other a negation. */
function clauseBefore(text: string, index: number): string {
  const sentence = (text.slice(Math.max(0, index - CLAUSE_LOOKBACK), index).split(SENTENCE_END).at(-1) ?? '');
  const lines = sentence.split('\n');
  const conditional = CONDITIONAL_OPENER.test(withoutRemediationLabel(lines.at(-1)!)) ? 'if ' : '';
  let clause = lastCommaClause(lines.pop()!);
  let blankLineBetween = false;
  while (lines.length > 0 && !LIST_OR_LABEL.test(clause)) {
    const previous = lines.pop()!;
    // "<br>\n" and "</p><p>" leave blank lines; they do not finish an unfinished negation.
    if (previous.trim() === '') { blankLineBetween = true; continue; }
    if (LIST_OR_LABEL.test(withoutRemediationLabel(previous)) || !(blankLineBetween ? WRAPPED_NEGATION : WRAPPED_LINE).test(previous)) break;
    clause = `${lastCommaClause(previous)} ${clause}`;
    blankLineBetween = false;
  }
  // A subject pronoun opens a new clause: "Since the token didn't refresh I restarted ...".
  const last = [...clause.matchAll(NEW_SUBJECTS)].at(-1);
  // ... unless that pronoun sits inside an unfinished negation: "I am not, I admit, checking".
  const afterSubject = last !== undefined && !NEGATION_BEFORE_SUBJECT.test(clause.slice(0, last.index)) ? clause.slice(last.index! + last[0].length) : clause;
  return conditional + afterSubject;
}

interface Span { start: number; end: number }

/** Matches of `pattern` that are the author's own words: command names, file names and
 * quoted output inside `literal` spans are evidence, never verbs or result markers. One pass over
 * the text: matches and literal spans both ascend. */
function matchesOutsideLiterals(text: string, pattern: RegExp): RegExpMatchArray[] {
  const literals: Span[] = [...text.matchAll(/`[^`]*`/gu)].map((literal) => ({ start: literal.index!, end: literal.index! + literal[0].length }));
  const kept: RegExpMatchArray[] = [];
  let next = 0;
  for (const match of text.matchAll(pattern)) {
    while (next < literals.length && literals[next].end <= match.index!) next++;
    if (next >= literals.length || match.index! < literals[next].start) kept.push(match);
  }
  return kept;
}

/** Does this (non-literal) action match survive: not negated, conditional, future or stopped? */
function isRealAction(text: string, match: RegExpMatchArray, current: boolean): boolean {
  const before = clauseBefore(text, match.index!);
  // Reject the whole unreal/negated clause, not just the adjacent word: "will not
  // be checking", "have not yet checked", and "plan on checking" are not facts.
  if (UNREAL.test(before)) return false;
  if (!current) return true;
  if (STOPPED.test(before)) return false;
  // Read the rest of THIS action clause too: a leading gerund can describe a
  // future/finished attempt. A line wrap that leaves an auxiliary at the start of
  // the next line ("checking<br>will be done") is still this clause.
  const from = match.index! + match[0].length;
  const after = text.slice(from, from + CLAUSE_LOOKAHEAD)
    .replace(/\n(?=[ \t]*(?:will|would|shall|is|are|was|were|has been|have been)(?![\p{L}\p{N}]))/giu, ' ')
    .split(CURRENT_AFTER_END)[0];
  return !FUTURE_AFTER.test(after);
}

function actionMatches(text: string, pattern: RegExp, current = false): RegExpMatchArray[] {
  return matchesOutsideLiterals(text, pattern).filter((match) => isRealAction(text, match, current));
}

/** Does this action's own text carry a concrete target plus an observed (not deferred) result?
 * Only the first few result markers after the action are its own; the target is the text just
 * before the marker. */
function observedResult(after: string): boolean {
  // A result word inside a literal or file name (`output.log`) names the checked target; try
  // the nearest real markers, since the target itself may contain one ("the failed deployment").
  const markers = matchesOutsideLiterals(after, RESULT).slice(0, RESULT_MARKERS_TRIED);
  if (markers.length > 0) {
    return markers.some((result) => {
      const target = after.slice(Math.max(0, result.index! - TARGET_LOOKBACK), result.index);
      const observed = after.slice(result.index! + result[0].length).replace(/^\s*[:—-]?\s*/u, '').split('\n')[0];
      return concrete(target) && concrete(observed) && !RESULT_DEFERRED.test(observed);
    });
  }
  const sentence = after.split('\n')[0];
  // A literal that itself contains a result marker is a quoted example, not an observation.
  const prose = sentence.replace(/`[^`]*`/gu, (literal) => [...literal.matchAll(RESULT)].length > 0 ? ' '.repeat(literal.length) : literal);
  return concrete(sentence) && /[:;—]/u.test(prose) && RESULT_FACT.test(prose);
}

function hasDoneResult(text: string): boolean {
  return actionMatches(text, PAST).some((action) => {
    const from = action.index! + action[0].length;
    return observedResult(text.slice(from, from + RESULT_LOOKAHEAD));
  });
}

function hardDependency(text: string): boolean {
  // Only the author's prose can assert a blocker, dependency or verification. Keep
  // UTF-16 offsets unchanged so a real assertion may still name a quoted command/target.
  const prose = text.replace(/`[^`]*`/gu, (literal) => literal.replace(/[^\r\n]/g, ' '));
  const gap = String.raw`[\s\S]{0,400}`;
  const stopped = [...prose.matchAll(new RegExp(`${WORD_START}(?:не могу|не можем|невозможно|запрещ[её]н|cannot|can['’]t|unable|blocked)${WORD_END}[\\s\\S]{0,400}?(?:из-за|потому|политик|:|because|due to)`, 'giu'))]
    // "If blocked …", "Not blocked …": a conditional or negated blocker is not a blocker.
    .find((blocker) => !UNREAL.test(clauseBefore(prose, blocker.index!)));
  if (stopped === undefined) return false;
  const dependency = new RegExp(`${WORD_START}(?:жду|ожидаю|нужен|нужна|требуется|waiting (?:for|on)|need(?:s)?)(?=[\\s:])`, 'iu').exec(prose);
  const verification = new RegExp(`${WORD_START}(?:после|как только|когда|after|once|when)${WORD_END}${gap}?(проверю|повторю|запущу|verify|recheck|retry|repeat|run)(?![\\p{L}\\p{N}])`, 'iu').exec(prose);
  if (dependency === null || verification === null) return false;
  const dependencyTarget = text.slice(dependency.index + dependency[0].length).replace(/^[\s:]+/u, '').split(/[.;\n]/u)[0];
  const verificationTarget = text.slice(verification.index + verification[0].length).split(/;|\n|[.!?](?:\s|$)/u)[0];
  return concrete(dependencyTarget) && concrete(verificationTarget);
}

function hasCurrent(evidence: ProblemEvidence): boolean {
  if (hardDependency(evidence.current)) return true;
  return actionMatches(evidence.current, CURRENT, true).some((action) => {
    const after = evidence.current.slice(action.index! + action[0].length).split(/;|\n|[.!?](?:\s|$)/u)[0];
    const isPresent = evidence.currentLabel || /[а-яё]/iu.test(action[0]) || /\b(?:now|currently|i am|i'm|we are|we're)\b/iu.test(evidence.current.slice(0, action.index));
    return isPresent && concrete(after);
  });
}

export function validateProblemRemediation(body: string): { ok: boolean; missing: string[] } {
  const evidence = problemRemediationEvidence(body);
  const missing: string[] = [];
  if (!hasDoneResult(evidence.done)) missing.push('Already tried — describe a concrete action you actually performed and its observed result. If nothing could start, state the attempted access/check and its real failure; never invent work.');
  if (!hasCurrent(evidence)) missing.push('Doing now — name the concrete recovery step currently in progress. For a hard blocker, state why no action can proceed, the exact dependency, and what you will verify when it clears. Passive monitoring or a future promise alone does not count.');
  return { ok: missing.length === 0, missing };
}
