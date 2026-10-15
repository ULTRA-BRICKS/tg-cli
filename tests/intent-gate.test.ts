// The pre-send intent gate (features/cli/intent-gate.ts, tg-cli#706): what a body IS — a
// decision ask, a problem, a report — tagged or not, and the verdict for it. The three
// fixtures under tests/fixtures/intent-gate/ are the real shapes that motivated the gate.
import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { decisionLabels, validateEscalationFormat } from '../features/cli/escalation-format';
import {
  classifyIntent,
  detectSignals,
  formatIntentVerdict,
  layaWorthAsking,
  validateProblemFormat,
  validateReportFormat,
} from '../features/cli/intent-gate';
import { FORMAT_HELP } from '../features/render/format-help';

const fixture = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', 'intent-gate', name), 'utf8');
const MALFORMED = fixture('malformed-decision.txt');
const REPORT_WITH_QUESTION = fixture('report-with-question.txt');
const WELL_FORMED = fixture('well-formed-decision.html');

const PROBLEM_OK = [
  '<h3>Контекст</h3><p>Деплой tg-cli на прод застрял: CI падает на шаге setup-bun из-за rate limit GitHub API.</p><hr>',
  '<h3>Что заблокировано</h3><ul><li>мерж #692 и всех PR после него</li></ul><hr>',
  '<h3>Что нужно от тебя</h3><ul><li>нужен токен GitHub с правом read:packages для раннера</li></ul><hr>',
  '<h3>Где смотреть</h3><ul><li>.github/workflows/ci.yml:20</li></ul>',
].join('\n');

// --- the three motivating fixtures ---------------------------------------------------

test('an untagged prose decision ("Решай, оставлять его или закрыть") is BLOCKED with the full missing list', () => {
  const v = classifyIntent({ body: MALFORMED });
  expect(v.action).toBe('block');
  if (v.action !== 'block') return;
  expect(v.reason).toBe('malformed-decision');
  expect(v.detail[0]).toBe('ask: «Решай, оставлять его или закрыть.»');
  const missing = v.detail.join('\n');
  for (const section of ['Options', 'Pros/cons', 'recommendation', 'Where to look', 'Glossary', 'Structure']) {
    expect(missing).toContain(section);
  }
});

test('a valid report that also asks a question is a FOLLOW-UP: the question is owed as a decision reply', () => {
  const v = classifyIntent({ body: REPORT_WITH_QUESTION });
  expect(v.action).toBe('follow-up');
  if (v.action !== 'follow-up') return;
  expect(v.kinds).toEqual(['decision', 'report']);
  expect(v.followUps).toEqual([
    { kind: 'decision', quote: 'Кстати, что делать с #566 — включать private_topics по умолчанию или нет?' },
  ]);
});

test('a well-formed decision passes — tagged, and untagged with a hint to tag it', () => {
  expect(classifyIntent({ body: WELL_FORMED, tag: 'decision' })).toEqual({ action: 'pass', kinds: ['decision'], hints: [], valid: 'decision' });
  const untagged = classifyIntent({ body: WELL_FORMED });
  expect(untagged.action).toBe('pass');
  expect(untagged.hints).toEqual(['This is a decision request: send it with --tag decision.']);
});

// --- detection ----------------------------------------------------------------------

test('asks: "?" sentences and decision imperatives, RU and EN; "или" continues the same ask', () => {
  expect(detectSignals('Мержим? Или ждём ревью?').asks).toEqual(['Мержим? Или ждём ревью?']);
  expect(detectSignals('Два вопроса: 1) мержить #694 сейчас? 2) удалять ветку?').asks).toHaveLength(2);
  expect(detectSignals('Жду твоего решения по #566.').asks).toHaveLength(1);
  expect(detectSignals('Выбери вариант, пожалуйста.').asks).toHaveLength(1);
  expect(detectSignals('Let me know which one you prefer.').asks).toHaveLength(1);
  expect(detectSignals('Мержу завтра, если нет возражений.').asks).toHaveLength(1);
});

test('not asks: quoted speech, code, URLs, tg#?, and a self-answered "why?" in a report', () => {
  expect(detectSignals('Ты спросил «зачем нужен X?» — отвечаю: для кэша.').asks).toEqual([]);
  expect(detectSignals('<pre>if (ok?) run()</pre> Всё собрано.').asks).toEqual([]);
  expect(detectSignals('Смотри `a ? b : c` и https://x.com/a?b=1 — всё там.').asks).toEqual([]);
  expect(detectSignals('FAILED tg#? sessions=0').asks).toEqual([]);
  expect(detectSignals('Почему падало? Флейк в ctl-тестах, починил ретраем.').asks).toEqual([]);
  // ...but an open choice followed by a recommendation is still an ask.
  expect(detectSignals('Мержить или ждать? Я бы мержил.').asks).toHaveLength(1);
});

test('problem and report kinds need explicit markers, not any mention of a failure', () => {
  expect(detectSignals('CI красный из-за флейка.').problems).toEqual([]);
  expect(detectSignals('Блокер: нет доступа к staging.').problems).toHaveLength(1);
  expect(detectSignals('I am blocked on the deploy key.').problems).toHaveLength(1);
  expect(detectSignals('Смержил #690, задеплоил.').reports).toHaveLength(1);
  expect(detectSignals('Надо смержить #690.').reports).toEqual([]);
});

// --- verdicts -----------------------------------------------------------------------

test('decision + problem + report in one message is BLOCKED as mixed', () => {
  const v = classifyIntent({ body: 'Смержил #690, тесты зелёные. Блокер: нет доступа к проду. Мержить #694 или ждать?' });
  expect(v.action).toBe('block');
  if (v.action === 'block') expect(v.reason).toBe('mixed');
});

test('a report that hides a blocker owes the blocker as a --tag problem reply', () => {
  const v = classifyIntent({ body: 'Смержил #690, тесты зелёные. Блокер: нет доступа к проду для деплоя.' });
  expect(v.action).toBe('follow-up');
  if (v.action === 'follow-up') expect(v.followUps.map((f) => f.kind)).toEqual(['problem']);
});

test('a malformed report (no reference, no verification) is BLOCKED; a short valid one passes', () => {
  const v = classifyIntent({ body: 'Готово, задеплоил.' });
  expect(v.action).toBe('block');
  if (v.action === 'block') {
    expect(v.reason).toBe('malformed-report');
    expect(v.detail.join('\n')).toContain('Reference');
    expect(v.detail.join('\n')).toContain('Verification');
  }
  expect(classifyIntent({ body: 'Готово: #690 смержен, CI зелёный, деплой прошёл.' }).action).toBe('pass');
});

test('a report with a malformed question and no proof is BLOCKED and names the question', () => {
  const v = classifyIntent({ body: 'Сделал фикс. Мержить?' });
  expect(v.action).toBe('block');
  if (v.action === 'block') {
    expect(v.reason).toBe('malformed-report');
    expect(v.detail.join('\n')).toContain('«Мержить?» goes out as its own --tag decision message');
  }
});

test('--tag problem: a blocker needs context, evidence, the ask and structure; its own request is not a decision', () => {
  const bare = classifyIntent({ body: 'Блокер: CI падает, без токена не починить.', tag: 'problem' });
  expect(bare.action).toBe('block');
  if (bare.action === 'block') expect(bare.reason).toBe('malformed-problem');
  expect(validateProblemFormat(PROBLEM_OK)).toEqual({ ok: true, missing: [] });
  expect(classifyIntent({ body: PROBLEM_OK, tag: 'problem' }).action).toBe('pass');
  const withRequest = PROBLEM_OK.replace('нужен токен GitHub', 'дашь токен GitHub?');
  expect(classifyIntent({ body: withRequest, tag: 'problem' }).action).toBe('pass');
  // An untagged blocker whose only question is its request is a problem, not a decision.
  expect(classifyIntent({ body: withRequest }).action).toBe('pass');
});

test('a problem that also asks the reader to choose owes the choice as a decision reply', () => {
  const v = classifyIntent({ body: `${PROBLEM_OK}\n<p>Откатить #692 или ждать фикса от GitHub?</p>`, tag: 'problem' });
  expect(v.action).toBe('follow-up');
  if (v.action === 'follow-up') expect(v.followUps).toEqual([{ kind: 'decision', quote: 'Откатить #692 или ждать фикса от GitHub?' }]);
});

test('--tag answer: a real answer with a question back owes it; a bare question back is BLOCKED', () => {
  const answer = classifyIntent({
    tag: 'answer',
    body: 'Да, логи посмотрел: падает из-за таймаута в ctl, поднял лимит до 30 с. Перезапустить демон сейчас?',
  });
  expect(answer.action).toBe('follow-up');
  const bare = classifyIntent({ tag: 'answer', body: 'А или Б?' });
  expect(bare.action).toBe('block');
  // An answer is not held to the report format.
  expect(classifyIntent({ tag: 'answer', body: 'Готово.' }).action).toBe('pass');
});

test('--automated skips the problem/report formats but still refuses a prose question', () => {
  expect(classifyIntent({ body: 'Память 95%, своп 80%.', tag: 'problem', automated: true }).action).toBe('pass');
  expect(classifyIntent({ body: 'Готово, задеплоил.', automated: true }).action).toBe('pass');
  expect(classifyIntent({ body: 'Перезапустить демон?', tag: 'problem', automated: true }).action).toBe('follow-up');
});

test('chatter with no ask, blocker or finished work passes untouched', () => {
  expect(classifyIntent({ body: 'ок, принял, начинаю' })).toEqual({ action: 'pass', kinds: [], hints: [] });
});

// --- several decisions --------------------------------------------------------------

test('a well-formed message carrying two decisions owes one reply per decision', () => {
  const second = WELL_FORMED.replace('<h3>Варианты</h3>', '<h3>Решение 2: ветка hotfix</h3><hr><h3>Варианты</h3>').replace(
    /<h3>Рекомендация<\/h3>/u,
    '<h3>Варианты</h3><table><tr><th>Вариант</th><th>Плюсы</th><th>Минусы</th></tr>' +
      '<tr><td>Удалить</td><td>чище</td><td>теряем историю</td></tr><tr><td>Оставить</td><td>история</td><td>шум</td></tr></table><hr><h3>Рекомендация</h3>',
  );
  expect(validateEscalationFormat(second).ok).toBe(true);
  expect(decisionLabels(second)).toHaveLength(2);
  const v = classifyIntent({ body: second, tag: 'decision' });
  expect(v.action).toBe('follow-up');
  if (v.action === 'follow-up') expect(v.followUps.map((f) => f.kind)).toEqual(['decision', 'decision']);
  expect(decisionLabels(WELL_FORMED)).toEqual(['decision 1']);
});

// --- glossary (decision format) -------------------------------------------------------

test('the decision format requires a glossary — a section, or an inline "Глоссарий:" label', () => {
  const noGlossary = WELL_FORMED.replace(/<h3>Глоссарий<\/h3>[\s\S]*?<\/ul>\n<hr>/u, '');
  expect(validateEscalationFormat(noGlossary).missing.join('\n')).toContain('Glossary');
  const inline = noGlossary.replace('<hr>', '<p>Глоссарий: флейк — тест, падающий случайно.</p><hr>');
  expect(validateEscalationFormat(inline).ok).toBe(true);
});

// --- laya ---------------------------------------------------------------------------

test('laya is asked only when the heuristic found no ask, and only adds a hint', () => {
  expect(layaWorthAsking({ body: MALFORMED })).toBe(false);
  expect(layaWorthAsking({ body: 'ок' })).toBe(false);
  expect(layaWorthAsking({ body: 'Готово: #690 смержен, CI зелёный, деплой прошёл.' })).toBe(true);
  expect(layaWorthAsking({ body: 'Готово: #690 смержен, CI зелёный, деплой прошёл.', automated: true })).toBe(false);
  const v = classifyIntent({ body: 'Готово: #690 смержен, CI зелёный, деплой прошёл.', layaAskProbability: 0.95 });
  expect(v.action).toBe('pass');
  expect(v.hints[0]).toContain('laya reads this message as asking the reader something (p=0.95)');
  expect(classifyIntent({ body: 'Готово: #690 смержен, CI зелёный, деплой прошёл.', layaAskProbability: 0.6 }).hints).toEqual([]);
});

// --- rendering ----------------------------------------------------------------------

test('the follow-up text names each item and the exact reply command with the sent id', () => {
  const v = classifyIntent({ body: REPORT_WITH_QUESTION });
  const text = formatIntentVerdict(v, 4242);
  expect(text).toContain('FOLLOW-UP REQUIRED');
  expect(text).toContain('[decision] «Кстати, что делать с #566');
  expect(text).toContain('tg --reply-to 4242 --tag decision --format html');
  expect(formatIntentVerdict(v)).toContain('--reply-to <id of this message>');
});

test('report format: a long report needs headings or a list', () => {
  const long = `Готово: #690 смержен, тесты зелёные. ${'Подробности изменений в демоне. '.repeat(20)}`;
  expect(validateReportFormat(long).missing.join('\n')).toContain('Structure');
  expect(validateReportFormat(`${long}\n- пункт один\n- пункт два`).ok).toBe(true);
});

test('the GOOD decision example in `tg help format` passes the decision format it documents', () => {
  const good = /GOOD \(renders[^\n]*\n\s*tg --tag decision --format html '([\s\S]*?)'\n/u.exec(FORMAT_HELP)?.[1] ?? '';
  expect(good).toContain('<h3>Glossary</h3>');
  expect(validateEscalationFormat(good.replace(/\n\s+/gu, '\n'))).toEqual({ ok: true, missing: [] });
});

// --- review findings (codex, tg-cli#706) ---------------------------------------------

test('a well-formed decision with an extra question outside it owes that question', () => {
  const v = classifyIntent({ body: `${WELL_FORMED}<p>Should I delete the production database too?</p>`, tag: 'decision' });
  expect(v.action).toBe('follow-up');
  if (v.action === 'follow-up') expect(v.followUps).toEqual([{ kind: 'decision', quote: 'Should I delete the production database too?' }]);
});

test('negated markers are not finished work or blockers; quoted text is not the sender’s blocker', () => {
  expect(classifyIntent({ body: 'I am not done yet; still investigating.' }).action).toBe('pass');
  expect(classifyIntent({ body: 'Смержил #690, тесты зелёные. Блокера нет.' }).action).toBe('pass');
  expect(classifyIntent({ body: 'The log says "I am blocked on access"; I am investigating.' }).action).toBe('pass');
});

test('a valid untagged problem is what settles a problem follow-up', () => {
  const v = classifyIntent({ body: PROBLEM_OK });
  expect(v.action).toBe('pass');
  if (v.action === 'pass') expect(v.valid).toBe('problem');
});

test('an unrelated negation in another clause does not hide finished work', () => {
  expect(detectSignals('I did not touch docs; implemented #706, tests pass.').reports).toHaveLength(1);
  expect(detectSignals('Доки не трогал, смержил #706.').reports).toHaveLength(1);
  expect(detectSignals('Ещё не смержил #706.').reports).toEqual([]);
});

test('only a whole decision-part heading hosts a question; look-alike headings do not', () => {
  for (const heading of ['Background checks', 'Decision appendix']) {
    const v = classifyIntent({ body: `${WELL_FORMED}<h3>${heading}</h3><p>Should I delete the production database too?</p>`, tag: 'decision' });
    expect(v.action).toBe('follow-up');
  }
  const inContext = WELL_FORMED.replace('</p>', ' Оставлять его или закрыть?</p>');
  expect(classifyIntent({ body: inContext, tag: 'decision' }).action).toBe('pass');
});

test('an --automated message never counts as settling a follow-up, decision or problem', () => {
  const decision = classifyIntent({ body: WELL_FORMED, tag: 'decision', automated: true });
  expect(decision).toEqual({ action: 'pass', kinds: ['decision'], hints: [] });
  const problem = classifyIntent({ body: PROBLEM_OK, tag: 'problem', automated: true });
  expect(problem.action).toBe('pass');
  if (problem.action === 'pass') expect(problem.valid).toBeUndefined();
});

test('numbered and phrased decision headings are recognised the same way the format validator does', () => {
  for (const heading of ['Context', '1. Context', '2) Контекст', 'Предлагаемые варианты']) {
    const body = WELL_FORMED.replace('<h3>Контекст</h3>', `<h3>${heading}</h3><p>Should we merge this PR?</p>`);
    expect(validateEscalationFormat(body).ok).toBe(true);
    expect(classifyIntent({ body, tag: 'decision' })).toEqual({ action: 'pass', kinds: ['decision'], hints: [], valid: 'decision' });
  }
});

test('a question before the first heading is an extra ask and cannot settle a follow-up', () => {
  const v = classifyIntent({ body: `<p>Should I delete the production database too?</p>\n${WELL_FORMED}`, tag: 'decision' });
  expect(v.action).toBe('follow-up');
  if (v.action === 'follow-up') expect(v.followUps).toEqual([{ kind: 'decision', quote: 'Should I delete the production database too?' }]);
});

test('"not only" / "не только" reports finished work, it does not negate it', () => {
  expect(detectSignals('Not only merged #706; tests passed.').reports).toHaveLength(1);
  expect(detectSignals('Не только смержил #706, но и прогнал тесты.').reports).toHaveLength(1);
  expect(classifyIntent({ body: 'Не только смержил, но и задеплоил.' }).action).toBe('block');
  expect(detectSignals('Not merged yet.').reports).toEqual([]);
});
