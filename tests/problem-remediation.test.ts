import { expect, test } from 'bun:test';
import { classifyIntent, detectSignals, formatIntentVerdict } from '../features/cli/intent-gate';
import { problemRemediationEvidence } from '../features/cli/problem-remediation';
import { BARE_PROBLEM, COMPLETE_PROBLEM, CURRENT_ACTION, HARD_BLOCKER, PAST_ACTION, RICH_PROBLEM } from './fixtures/intent-gate/problem-remediation';
import { readFileSync } from 'fs';
import { join } from 'path';

// A high model score must never override missing concrete action/result evidence.
const positive = { status: 'ok' as const, done: 0.99, current: 0.99 };

const blockerExample = 'Cannot continue because device policy denies access. Waiting for owner approval; once available, retry browser login.';
for (const [name, current] of [
  ['code', `<code>${blockerExample}</code>`],
  ['preformatted', `<pre>${blockerExample}</pre>`],
  ['double quotation', `"${blockerExample}"`],
  ['entity quotation', `&#34;${blockerExample}&#x22;`],
  ['quoted reason and dependency assertions', 'Cannot continue <code>because device policy denies access. Waiting for owner approval; once available, retry browser login.</code>'],
  ['quoted dependency and verification', 'Cannot continue because device policy denies access. The example says <code>Waiting for owner approval; once available, retry browser login.</code>'],
  ['quoted verification', 'Cannot continue because device policy denies access. Waiting for owner approval; <code>once available, retry browser login.</code>'],
] as const) {
  test(`hard blocker literal cannot replace author assertions: ${name}`, () => {
    const verdict = classifyIntent({ body: `${PAST_ACTION}\nDoing now: ${current}`, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain('Doing now');
    expect(formatIntentVerdict(verdict)).not.toContain('Already tried —');
  });
}

for (const current of [
  'Cannot continue because device policy denies access. Waiting for "owner approval"; once available, run <code>browser.login</code>.',
  'Cannot continue because <code>permission denied</code>. Waiting for owner approval; once available, run <code>pytest</code>.',
  'Cannot continue because device policy denies access. Waiting for <code>🧪 owner approval</code>; once available, retry <code>browser login</code>.',
]) {
  test(`hard blocker author assertions retain quoted dependency/command targets: ${current}`, () => {
    expect(classifyIntent({ body: `${PAST_ACTION}\nDoing now: ${current}`, tag: 'problem', automated: true }).action).toBe('pass');
  });
}

for (const negation of ['n&#111;t', 'n&#x6f;t', '&#110;&#111;&#116;', 'n&#X006F;t']) {
  test(`visible numeric-entity negation cannot claim performed/current actions: ${negation}`, () => {
    const body = `Already tried: I have ${negation} checked browser permissions; result: permission denied.\nDoing now: I am ${negation} checking browser permissions.`;
    const verdict = classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain('Already tried');
    expect(formatIntentVerdict(verdict)).toContain('Doing now');
  });
}

test('numeric entities in actual action words, labels and whitespace use their visible text', () => {
  const body = 'Alr&#101;ady tried: Ch&#101;cked browser permissions; result: permission denied.&#10;Doing now: Ch&#x65;cking browser&#160;permissions.';
  expect(classifyIntent({ body, tag: 'problem', automated: true }).action).toBe('pass');
  const evidence = problemRemediationEvidence(body);
  expect(evidence.done).toContain('Checked browser permissions');
  expect(evidence.current).toContain('Checking browser\u00a0permissions');
});

test('numeric entities preserve quote/code boundaries and cannot create HTML structure', () => {
  for (const body of [
    `<code>&#96;${COMPLETE_PROBLEM}&#x60;</code>`,
    `<pre>&#96;${COMPLETE_PROBLEM}&#x60;</pre>`,
    `The example says &#x22;${COMPLETE_PROBLEM.replace('Проверил', 'Пров&#1077;рил')}&#34;`,
  ]) expect(classifyIntent({ body, tag: 'problem', automated: true }).action).toBe('block');
  const body = 'Already tried: Checked browser permissions; result: the output was &#60;h3&#62;Doing now&#60;/h3&#62; with permission denied.\nDoing now: Checking browser permissions.';
  const evidence = problemRemediationEvidence(body);
  expect(evidence.done).toContain('<h3>Doing now</h3>');
  expect(evidence.current).toBe('Checking browser permissions.');
  expect(classifyIntent({ body, tag: 'problem', automated: true }).action).toBe('pass');
});

test('numeric entities decode once and leave malformed or invalid scalar references intact', () => {
  const raw = '&amp;#111; &#38;#111; &#0; &#xD800; &#1114112; &#x110000; &#xZZ; &#111';
  const evidence = problemRemediationEvidence(`Already tried: Checked browser permissions; result: ${raw}.\nDoing now: Checking browser permissions.`);
  expect(evidence.done).toContain('&#111; &#111; &#0; &#xD800; &#1114112; &#x110000; &#xZZ; &#111');
  const boundary = problemRemediationEvidence('Already tried: Ran browser.tabs; result: &#x1F9EA; &#1114111;.');
  expect(boundary.done).toContain(`\u{1f9ea} \u{10ffff}`);
  for (const entity of ['&#0;', '&#xD800;', '&#1114112;', '&#xZZ;', '&#111']) {
    const body = `Already tried: Check${entity}ed browser permissions; result: permission denied.\nDoing now: Checking browser permissions.`;
    expect(classifyIntent({ body, tag: 'problem', automated: true }).action).toBe('block');
  }
});

for (const [name, body] of [
  ['original monitoring-only alert', BARE_PROBLEM],
  ['vague monitoring', `${BARE_PROBLEM}\nУже сделал: Проверил.\nСейчас делаю: Наблюдаю за ситуацией.`],
  ['empty headings', '<h3>Уже сделал</h3><hr><h3>Сейчас делаю</h3>'],
  ['past action without observed result', `Проверил список вкладок браузера.\n${CURRENT_ACTION}`],
  ['past action only', PAST_ACTION],
  ['current action only', CURRENT_ACTION],
  ['future promise only', 'Я проверю список вкладок, а потом попробую восстановить чат.'],
  ['future promise under past/current headings', 'Уже сделал: Проверю список вкладок, результат узнаю позже.\nСейчас делаю: Попробую восстановить чат завтра.'],
  ['unknown result deferred until later', `Уже сделал: Проверил список вкладок; результат: позже получу список ответов.\n${CURRENT_ACTION}`],
  ['future continuous action', `${PAST_ACTION}\nDoing now: I will be checking browser permissions tomorrow.`],
  ['negated current action', `${PAST_ACTION}\nDoing now: I am not currently checking browser permissions.`],
  ['past continuous action', `${PAST_ACTION}\nDoing now: I was checking browser permissions yesterday.`],
  ['negated future continuous', `${PAST_ACTION}\nDoing now: I will not be checking browser permissions tomorrow.`],
  ['intention instead of current action', `${PAST_ACTION}\nDoing now: I plan on checking browser permissions tomorrow.`],
  ['trailing future predicate', `${PAST_ACTION}\nDoing now: Checking browser permissions is what I will do tomorrow.`],
  ['scheduled action', `${PAST_ACTION}\nDoing now: Checking browser permissions is scheduled for tomorrow.`],
  ['stopped attempt', `${PAST_ACTION}\nDoing now: I stopped checking browser permissions yesterday.`],
  ['finished attempt', `${PAST_ACTION}\nDoing now: I have finished checking browser permissions.`],
  ['unperformed past action', `Already tried: I have not yet checked browser tabs; result: chat 6ae07d22 was absent.\n${CURRENT_ACTION}`],
  ['hypothetical past action', `Already tried: If I had checked browser tabs; result: chat 6ae07d22 was absent.\n${CURRENT_ACTION}`],
  ['hard blocker with no verification target', `${PAST_ACTION}\nDoing now: Cannot continue because device policy denies browser access. Waiting for owner approval; once available, verify.`],
  ['quoted action example', `${BARE_PROBLEM}\n<blockquote>${COMPLETE_PROBLEM}</blockquote>`],
  ['inline quoted action example', 'The example says "Already tried: Listed browser tabs; result: chat was absent. Doing now: Opening saved chat URL and verifying its identifier."'],
  ['entity-escaped quoted example', `<p>The example says &quot;${COMPLETE_PROBLEM}&quot;</p>`],
  ['numeric-escaped quoted example', `<p>The example says &#34;${COMPLETE_PROBLEM}&#x22;</p>`],
  ['inline code sample', `The example says: <code>${COMPLETE_PROBLEM}</code>`],
  ['fenced action example', `${BARE_PROBLEM}\n\`\`\`\n${COMPLETE_PROBLEM}\n\`\`\``],
] as const) {
  test(`problem remediation blocks ${name}, including --automated and positive Laya`, () => {
    const verdict = classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    if (verdict.action !== 'block') return;
    expect(verdict.reason).toBe('incomplete-problem-remediation');
    expect(formatIntentVerdict(verdict)).toContain('nothing');
  });
}

test('past-only and current-only rejection identify the exact missing requirement', () => {
  const past = classifyIntent({ body: PAST_ACTION, tag: 'problem', automated: true });
  expect(formatIntentVerdict(past)).toContain('Doing now');
  expect(formatIntentVerdict(past)).not.toContain('Already tried —');
  const current = classifyIntent({ body: CURRENT_ACTION, tag: 'problem', automated: true });
  expect(formatIntentVerdict(current)).toContain('Already tried');
  expect(formatIntentVerdict(current)).not.toContain('Doing now —');
});

test('an empty or unrelated result section cannot supply an attempted action result', () => {
  const attempt = '<h3>Already tried</h3><p>Ran <code>pytest -q</code>.</p><hr>';
  const current = '<h3>Doing now</h3><p>Fixing the failing database migration.</p>';
  for (const result of [
    '<h3>Result</h3><hr>',
    '<h3>Separate task</h3><p>A previous deployment was tested.</p><h3>Result</h3><p>3 tests failed with permission denied.</p>',
  ]) {
    const verdict = classifyIntent({ body: attempt + result + current, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain('Already tried');
  }
});

for (const current of [
  'Сейчас делаю: читаю журнал ошибок Guardian.',
  'Сейчас делаю: читаем журнал ошибок Guardian.',
  'Сейчас делаю: меняю таймаут подключения в конфигурации Guardian.',
  'Сейчас делаю: меняем таймаут подключения в конфигурации Guardian.',
  'Сейчас делаю: подключаюсь к резервному браузеру Guardian.',
  'Сейчас делаю: подключаемся к резервному браузеру Guardian.',
  'Сейчас делаю: перенастраиваю адрес сервера Guardian.',
  'Сейчас делаю: перенастраиваем адрес сервера Guardian.',
  'Doing now: Reading the Guardian error log.',
  'Doing now: Changing the connection timeout in the Guardian configuration.',
  'Doing now: Connecting to the backup Guardian browser.',
  'Doing now: Inspecting the failed Guardian connection.',
  'Doing now: Reconfiguring the Guardian server address.',
]) {
  test(`concrete recovery verb is accepted: ${current}`, () => {
    expect(classifyIntent({ body: `${PAST_ACTION}\n${current}`, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
  });
}

for (const current of [
  'Сейчас делаю: не читаю журнал ошибок Guardian.',
  'Сейчас делаю: планирую подключаться к резервному браузеру Guardian.',
  'Doing now: I will be reading the Guardian error log.',
  'Doing now: I am not currently changing the Guardian connection timeout.',
  'Doing now: I plan on connecting to the backup Guardian browser.',
  'Doing now: I was inspecting the failed Guardian connection.',
  'Doing now: Reconfiguring.',
]) {
  test(`recovery verb still needs actual current work: ${current}`, () => {
    const verdict = classifyIntent({ body: `${PAST_ACTION}\n${current}`, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain('Doing now');
  });
}

for (const [name, body] of [
  ['concrete past result plus current recovery', COMPLETE_PROBLEM],
  ['honest permission blocker with attempted alternative and verification trigger', HARD_BLOCKER],
  ['English action report', 'Already tried: Listed browser tabs twice; result: chat 6ae07d22 was absent.\nDoing now: Opening the saved chat URL and verifying its chat identifier.'],
  ['inline command and observed output', 'Уже сделал: Запустил <code>browser.tabs</code>; получил <code>permission denied</code>.\nСейчас делаю: Проверяю доступность резервного браузера через health endpoint.'],
  ['current command identifier', `${PAST_ACTION}\nСейчас делаю: Проверяю browser.tabs.`],
  ['English trying-now synonym', 'Already tried: Listed tabs in the home profile; result: the chat was absent.\nTrying now: reopening the saved chat URL in that profile.'],
  ['single command and measured result', `Already tried: Ran pytest; result: 3 tests failed.\n${CURRENT_ACTION}`],
  ['quoted observed output', 'Already tried: Ran pytest; received "permission denied".\nDoing now: Checking the available browser permissions.'],
  ['command plus preformatted observed output', '<h3>Already tried</h3><p>Ran <code>pytest -q</code>; result:</p><pre>3 failed, 47 passed</pre><h3>Doing now</h3><p>Fixing the failing database migration.</p>'],
  ['separate English result section', '<h3>Already tried</h3><p>Ran <code>pytest -q</code>.</p><hr><h3>Result</h3><p>3 tests failed with permission denied.</p><hr><h3>Doing now</h3><p>Fixing the failing database migration.</p>'],
  ['separate Russian result section', '<h3>Уже сделал</h3><p>Запустил <code>pytest -q</code>.</p><hr><h3>Результат</h3><p>Три теста упали из-за отсутствия доступа.</p><hr><h3>Сейчас делаю</h3><p>Исправляю права доступа для тестового процесса.</p>'],
  ['current recovery followed by next verification', `${PAST_ACTION}\nDoing now: I am checking browser permissions; next I will verify the login response tomorrow.`],
  ['current recovery and a future verification', `${PAST_ACTION}\nDoing now: I am checking browser permissions and then I will verify the login response.`],
  ['Russian current recovery and a future verification', `${PAST_ACTION}\nСейчас делаю: проверяю права доступа браузера и затем проверю ответ сервера.`],
] as const) {
  test(`problem remediation accepts ${name}`, () => {
    expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
  });
}

test('an autonomous rich problem needs no unnecessary request to a human', () => {
  expect(classifyIntent({ body: RICH_PROBLEM, tag: 'problem', layaProblemAssessment: positive }).action).toBe('pass');
});

test('a problem tag cannot bypass remediation by using decision-shaped HTML', () => {
  const body = readFileSync(join(import.meta.dir, 'fixtures', 'intent-gate', 'well-formed-decision.html'), 'utf8');
  expect(classifyIntent({ body, tag: 'problem' }).action).toBe('block');
});

test('remediation headings alone do not misclassify a problem as a completed-work report', () => {
  expect(detectSignals(PAST_ACTION).reports).toEqual([]);
});

test('completed recovery work inside a problem can carry a separate decision follow-up', () => {
  const body = RICH_PROBLEM.replace('Проверил список', 'Исправил фильтр вкладок и проверил список') + '<p>Откатить сервис или продолжать восстановление?</p>';
  expect(classifyIntent({ body, tag: 'problem' }).action).toBe('follow-up');
});

test('confident Laya negative evidence blocks a syntactically complete problem', () => {
  const verdict = classifyIntent({ body: COMPLETE_PROBLEM, tag: 'problem', automated: true, layaProblemAssessment: { status: 'ok', done: 0.03, current: 0.9 } });
  expect(verdict.action).toBe('block');
  expect(formatIntentVerdict(verdict)).toContain('Laya');
  expect(formatIntentVerdict(verdict)).toContain('Already tried');
});

test('ambiguous Laya scores cannot reject complete deterministic evidence', () => {
  const body = 'Проблема: вкладка чата не открыта.\nУже сделал: проверил список вкладок профиля home.\nРезультат: нужный чат отсутствует в списке.\nСейчас делаю: открываю сохранённый URL в профиле home.\nСледующая проверка: через 30 секунд проверю URL и наличие поля ввода.\nОт пользователя действий не требуется.';
  const verdict = classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: { status: 'ok', done: 0.6166, current: 0.4625 } });
  expect(verdict.action).toBe('pass');
  expect(formatIntentVerdict(verdict)).toContain('inconclusive');
});

test('unavailable Laya is diagnosed separately and deterministic valid evidence still passes', () => {
  const assessment = { status: 'unavailable' as const, reason: 'timeout' as const };
  const valid = classifyIntent({ body: COMPLETE_PROBLEM, tag: 'problem', automated: true, layaProblemAssessment: assessment });
  expect(valid.action).toBe('pass');
  expect(formatIntentVerdict(valid)).toContain('unavailable (timeout)');
  const invalid = classifyIntent({ body: BARE_PROBLEM, tag: 'problem', automated: true, layaProblemAssessment: assessment });
  expect(invalid.action).toBe('block');
  expect(formatIntentVerdict(invalid)).toContain('Already tried');
  expect(formatIntentVerdict(invalid)).toContain('unavailable (timeout)');
});

test('non-problem reports keep their existing behavior and ignore problem assessment', () => {
  expect(classifyIntent({ body: 'Готово, задеплоил.', tag: 'report', automated: true, layaProblemAssessment: { status: 'ok', done: 0, current: 0 } }).action).toBe('pass');
});

test('action evidence beyond the first 2000 characters remains valid', () => {
  const body = `Guardian home: ${'Дополнительные сведения о состоянии браузера. '.repeat(90)}\n${PAST_ACTION}\n${CURRENT_ACTION}`;
  expect(body.indexOf(PAST_ACTION)).toBeGreaterThan(2000);
  expect(classifyIntent({ body, tag: 'problem', automated: true }).action).toBe('pass');
});

// A line break or <br> inside one sentence is a wrap, not a sentence boundary.
const WRAP_PAST = 'Already tried: Checked browser state; result: tab missing.';
for (const [name, current] of [
  ['<br>', 'Doing now: I am not<br>checking browser permissions.'],
  ['<br/> with adverb', 'Doing now: I am not<br/>currently<br/>checking browser permissions.'],
  ['plain newline', 'Doing now: I am not\nchecking browser permissions.'],
  ['future auxiliary', 'Doing now: I will<br>be checking browser permissions tomorrow.'],
  ['intention', 'Doing now: I plan<br>on checking browser permissions tomorrow.'],
  ['was', 'Doing now: I was<br>checking browser permissions yesterday.'],
  ['Russian negation', 'Сейчас делаю: Мы не<br>проверяем права доступа браузера.'],
  ['trailing future predicate', 'Doing now: Checking browser permissions<br>will be done tomorrow.'],
  ['<br> followed by a source newline', 'Doing now: I am not<br>\nchecking browser permissions.'],
  ['split paragraphs', 'Doing now: I am not</p><p>checking browser permissions.'],
] as const) {
  test(`line wrap does not sever negation or future scope: ${name}`, () => {
    for (const body of [`${WRAP_PAST}\n${current}`, `<p>${WRAP_PAST}</p><p>${current.replace(/\n/gu, '<br>')}</p>`]) {
      const verdict = classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive });
      expect(verdict.action).toBe('block');
      expect(formatIntentVerdict(verdict)).toContain('Doing now');
    }
  });
}

test('line wrap does not sever negation of the attempted action either', () => {
  for (const past of [
    'Already tried: I have not<br>checked browser state; result: tab missing.',
    'Уже сделал: Я не<br>проверил вкладки браузера; результат: вкладка отсутствует.',
  ]) {
    const body = `${past}\nDoing now: Checking browser permissions.`;
    const verdict = classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain('Already tried');
  }
});

for (const [name, current] of [
  ['unrelated negated line above', 'Doing now: The tab state is still not known\nChecking browser permissions.'],
  ['negated full sentence above', 'Doing now: Chat 6ae07d22 is not visible.\nChecking browser permissions.'],
  ['negation in a previous list item', 'Doing now:\n- I will not retry the old URL\n- Checking browser permissions.'],
  ['paragraph boundary', '<p>Doing now: I am not sure</p><p>Checking browser permissions.</p>'],
] as const) {
  test(`line wrap handling does not invent a negation across independent lines: ${name}`, () => {
    expect(classifyIntent({ body: `${WRAP_PAST}\n${current}`, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
  });
}

// "output"/"result" inside a code literal or filename is evidence, not the result marker.
for (const target of [
  '<code>output.log</code>', '<code>result.json</code>', '`output.log`', '`result.json`', 'output.log', 'result.json',
  '<code>output</code> file <code>result.json</code>',
]) {
  test(`result word inside the checked target is not the result marker: ${target}`, () => {
    const body = `Already tried: Checked ${target}; result: permission denied.\nDoing now: Checking browser permissions.`;
    expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
  });
}

for (const [name, body] of [
  ['literal output marker alone is not an observed result', 'Already tried: Checked <code>output.log</code>.\nDoing now: Checking browser permissions.'],
  ['quoted example of a whole report', 'The example says "Already tried: Checked output.log; result: permission denied. Doing now: Checking browser permissions."'],
  ['code example of result marker', 'Already tried: Checked tabs <code>result: permission denied</code>.\nDoing now: <code>Checking browser permissions.</code>'],
] as const) {
  test(`literal result markers do not create a pass: ${name}`, () => {
    expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('block');
  });
}

const RU_PAST = 'Уже сделал: Посмотрел журнал Guardian; результат: HTTP 429 при открытии вкладки.';
for (const current of [
  'Сейчас делаю: Чиню повторные попытки открытия вкладки с учётом Retry-After.',
  'Сейчас делаю: Чиним повторные попытки открытия вкладки с учётом Retry-After.',
]) {
  test(`Russian repair verb is a current action: ${current}`, () => {
    for (const body of [`${RU_PAST}\n${current}`, `${RU_PAST} ${current}`]) {
      expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
    }
  });
}

for (const current of [
  'Сейчас делаю: Не чиню повторные попытки открытия вкладки.',
  'Сейчас делаю: Мы не чиним повторные попытки открытия вкладки.',
  'Сейчас делаю: Планирую чинить, а затем чиню повторные попытки завтра.',
  'Сейчас делаю: Буду чинить повторные попытки открытия вкладки.',
  'Сейчас делаю: Если получится, чиню повторные попытки открытия вкладки.',
  'Сейчас делаю: Собираюсь чиню повторные попытки открытия вкладки.',
  'Сейчас делаю: «Чиню повторные попытки открытия вкладки».',
  'Сейчас делаю: <code>Чиню повторные попытки открытия вкладки</code>.',
  'Сейчас делаю: Чиню.',
]) {
  test(`Russian repair verb is rejected when negated, future, quoted or empty: ${current}`, () => {
    const body = `${RU_PAST}\n${current}`;
    const verdict = classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain('Doing now');
  });
}

// Independent review (#817): contractions, modals, time words, wraps, file names, deferred results.
const DONE_OK = 'Already tried: Checked browser state; result: tab missing.';
const NOW_OK = 'Doing now: Checking browser permissions.';
for (const [name, body, missing] of [
  ['contracted negation of the attempt', `Already tried: I haven't checked browser tabs; result: chat 6ae07d22 was absent.\n${NOW_OK}`, 'Already tried'],
  ['contracted negation of current work', `${DONE_OK}\nDoing now: I won't be checking browser permissions.`, 'Doing now'],
  ['contracted future', `${DONE_OK}\nDoing now: I'll be checking browser permissions.`, 'Doing now'],
  ['no longer', `${DONE_OK}\nDoing now: I am no longer checking browser permissions.`, 'Doing now'],
  ['modal', `${DONE_OK}\nDoing now: I should be checking browser permissions.`, 'Doing now'],
  ['relative clause with a future', `${DONE_OK}\nDoing now: Checking browser permissions, which I will finish tomorrow.`, 'Doing now'],
  ['conjoined action that is only planned', `${DONE_OK}\nDoing now: Checking and fixing permissions is planned for tomorrow.`, 'Doing now'],
  ['bare time word', `${DONE_OK}\nDoing now: Checking browser permissions tomorrow.`, 'Doing now'],
  ['Russian time word', `${DONE_OK}\nСейчас делаю: Перезапускаю воркер браузера завтра.`, 'Doing now'],
  ['conditional blocker', `${DONE_OK}\nDoing now: If blocked because of device policy, I will need owner approval; once granted I will retry browser login.`, 'Doing now'],
  ['negated blocker', `${DONE_OK}\nDoing now: Not blocked because of device policy. Need nothing more; once it loads, verify chat identifier.`, 'Doing now'],
  ['wrap after "not yet started"', `${DONE_OK}\nDoing now: We have not yet started<br>checking browser permissions.`, 'Doing now'],
  ['wrap after an ordinary adverb', `${DONE_OK}\nDoing now: I am not actively<br>checking browser permissions.`, 'Doing now'],
  ['negation with a file name before the action', `${DONE_OK}\nDoing now: I am not inspecting output.log or checking browser permissions.`, 'Doing now'],
  ['negated attempt with a file name', 'Already tried: Have not checked output.log or inspected browser tabs; result: permission denied.\n' + NOW_OK, 'Already tried'],
  ['future result', `Already tried: Checked browser tabs; result: will be available tomorrow.\n${NOW_OK}`, 'Already tried'],
  ['unknown result', `Already tried: Checked browser tabs; result: not yet known.\n${NOW_OK}`, 'Already tried'],
  ['unobserved state of mind', `Already tried: Restarted the browser; still investigating.\n${NOW_OK}`, 'Already tried'],
  ['quoted result marker in the attempt', `Already tried: Checked tabs <code>result: permission denied</code>.\n${NOW_OK}`, 'Already tried'],
] as const) {
  test(`review finding is rejected: ${name}`, () => {
    const verdict = classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain(missing);
  });
}

for (const [name, body] of [
  ['result word inside the target', `Already tried: Checked the failed deployment; result: permission denied.\n${NOW_OK}`],
  ['Russian result word inside the target', `Уже сделал: Проверил ответ сервера; результат: 502.\n${NOW_OK}`],
  ['result word in a path', `Already tried: Inspected build/output/app.log; result: permission denied.\n${NOW_OK}`],
  ['result word in a hyphenated name', `Already tried: Checked result-cache; result: permission denied.\n${NOW_OK}`],
  ['feminine attempt verb', `Уже сделал: Попыталась открыть сохранённый чат; результат: вкладка отсутствует.\n${NOW_OK}`],
  ['earlier negation in a subordinate clause (attempt)', `Already tried: Since the retry did not help, I restarted the Guardian browser; result: still 401.\n${NOW_OK}`],
  ['earlier negation joined by "so"', `Already tried: The login did not work so I restarted the auth service; result: still 401.\n${NOW_OK}`],
  ['Russian earlier negation', `Уже сделал: Сервис не отвечал, поэтому перезапустил сервис авторизации; результат: снова 502.\n${NOW_OK}`],
  ['earlier negation in a subordinate clause (current)', `${DONE_OK}\nDoing now: Since the retry did not help, restarting the Guardian browser.`],
  ['negation contrasted with a real action', `${DONE_OK}\nDoing now: We are not checking browser permissions but fixing the login proxy.`],
  ['line ending in "or not" is not a wrap', `${DONE_OK}\nDoing now: Chat tab closed or not\nrestarting the Guardian browser.`],
  ['investigating verb', `${DONE_OK}\nDoing now: Investigating the Guardian retry loop in the browser worker.`],
  ['Russian trying verb', `${DONE_OK}\nСейчас делаю: Пробую открыть сохранённый адрес чата.`],
] as const) {
  test(`review finding keeps a legitimate report: ${name}`, () => {
    expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
  });
}

for (const current of [
  'Doing now: Recreating the tab from the saved URL.',
  'Doing now: Rotating the expired token in the Guardian config.',
  'Doing now: Reconnecting the browser worker to the backup profile.',
  'Сейчас делаю: Пересоздаю вкладку чата из сохранённого адреса.',
  'Сейчас делаю: Переподключаю браузерный воркер к резервному профилю.',
]) {
  test(`realistic recovery verb is a current action: ${current}`, () => {
    expect(classifyIntent({ body: `${DONE_OK}\n${current}`, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
  });
}

test('a legitimate report that mentions possibility, a deadline or a cause keeps passing', () => {
  for (const body of [
    'Already tried: Queried the API; result: 401 unauthorized, the token may have expired.\nDoing now: Rotating the token in the config and restarting the worker.',
    'Already tried: Opened chat 6ae07d22 in the home profile; result: tab missing, session cookie expired.\nDoing now: Re-opening the saved chat URL with a fresh cookie, then I will verify the chat id.',
    'Already tried: Listed the browser tabs; found nothing for chat 6ae07d22 (result: no matching tab).\nDoing now: Searching the history for the last known URL, because the tab was closed.',
    'Already tried: Checked whether the tab exists; result: it does not (404).\nDoing now: Recreating the tab from the saved URL.',
  ]) expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
});

// Second independent review: false rejects introduced by the first batch and a comma bypass.
for (const [name, body] of [
  ['relative clause that was stopped', `${DONE_OK}\nDoing now: Restarting the worker that was stopped by OOM.`],
  ['purpose clause with a future', `${DONE_OK}\nDoing now: Patching the config so the worker will restart cleanly.`],
  ['relative clause that was paused', `${DONE_OK}\nDoing now: Re-running the migration that was paused at step 4.`],
  ['previous paragraph ends in a status word', `${DONE_OK}\n<h3>Doing now</h3><p>Sync worker paused</p><p>Restarting the sync worker on node-2.</p>`],
  ['previous labelled line ends in a status word', `${DONE_OK}\nDoing now:\nWorker status: stopped\nRestarting the worker on node-2.`],
  ['May as a month', 'Already tried: After the May 3 deploy I rolled back the config; result: HTTP 200.\n' + NOW_OK],
  ['plan as a noun', `${DONE_OK}\nDoing now: Per the plan I am restarting node-2.`],
  ['Russian через as "via"', `${DONE_OK}\nСейчас делаю: Проверяю доступ к API через 443-й порт прокси.`],
  ['soon as a property of the target', `${DONE_OK}\nDoing now: Checking why the cert expires soon.`],
  ['negated subordinate clause without a comma (attempt)', `Already tried: Since the token didn't refresh I restarted the auth service; result: still 401.\n${NOW_OK}`],
  ['negated clause joined by "and" (attempt)', `Already tried: The retry did not help and I restarted the auth service; result: still 401.\n${NOW_OK}`],
  ['negated first blocker, real second blocker', `${DONE_OK}\nDoing now: Not blocked by the network: ping works. Cannot continue because device policy denies browser access. Waiting for owner approval; once granted, retry browser login.`],
] as const) {
  test(`second review keeps a legitimate report: ${name}`, () => {
    expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
  });
}

for (const [name, current] of [
  ['parenthetical after a negation', 'Doing now: I am not, for now, checking browser permissions.'],
  ['parenthetical after a contraction', "Doing now: I won't, realistically, be checking browser permissions."],
  ['negation then paragraph split', '<p>Doing now: I am not</p><p>checking browser permissions.</p>'],
] as const) {
  test(`second review rejects a negation hidden by a comma or paragraph: ${name}`, () => {
    const verdict = classifyIntent({ body: `${DONE_OK}\n${current}`, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain('Doing now');
  });
}

// Third independent review: deferred results that do not start with the deferral, negation hidden
// by a pronoun/dash/parenthesis, and relative clauses about the target.
for (const result of [
  'still unknown.', 'still pending.', 'still investigating.', 'we will know tomorrow.', 'it is not yet known.',
]) {
  test(`third review rejects a deferred observed result: ${result}`, () => {
    const body = `Already tried: Checked the browser tabs; result: ${result}\n${NOW_OK}`;
    const verdict = classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain('Already tried');
  });
}

test('third review rejects a Russian deferred observed result', () => {
  const body = `Уже сделал: Проверил вкладки браузера; результат: мы ещё не знаем.\n${NOW_OK}`;
  expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('block');
});

for (const [name, current] of [
  ['pronoun inside a parenthetical', 'Doing now: I am not, I admit, checking browser permissions.'],
  ['pronoun inside a second parenthetical', "Doing now: We won't, I think, be checking browser permissions."],
  ['parentheses', 'Doing now: I am not (I admit) checking browser permissions.'],
  ['belief verb before a pronoun', "Doing now: I don't think we are restarting the worker."],
  ['Russian belief verb', 'Сейчас делаю: Не думаю, что мы перезапускаем воркер.'],
  ['dash parenthetical', 'Doing now: I am not — for now — checking browser permissions.'],
] as const) {
  test(`third review rejects a negation hidden from the action: ${name}`, () => {
    const verdict = classifyIntent({ body: `${DONE_OK}\n${current}`, tag: 'problem', automated: true, layaProblemAssessment: positive });
    expect(verdict.action).toBe('block');
    expect(formatIntentVerdict(verdict)).toContain('Doing now');
  });
}

test('third review rejects a dash-parenthetical negation of the attempt', () => {
  const body = `Already tried: I have not — honestly — checked the tabs; result: permission denied.\n${NOW_OK}`;
  expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('block');
});

for (const [name, body] of [
  ['job scheduled for a time', `${DONE_OK}\nDoing now: Re-running the backup job that was scheduled for 03:00.`],
  ['whether it will start', `${DONE_OK}\nDoing now: Testing whether the patched worker will start cleanly.`],
  ['certificate that expires tomorrow', `${DONE_OK}\nDoing now: Rotating the TLS certificate that expires tomorrow.`],
  ['cron job that runs later', `${DONE_OK}\nDoing now: Fixing the cron job that runs in 10 minutes.`],
  ['Russian relative clause', `${DONE_OK}\nСейчас делаю: Перезапускаю воркер, который падает через 5 минут после старта.`],
  ['a result that is a failure to start', `Already tried: Ran the service; result: it will not start (exit 1).\n${NOW_OK}`],
  ['pending jobs as the observation', `Already tried: Ran the batch; result: 3 pending jobs failed with error 500.\n${NOW_OK}`],
  ['May as a month before a comma', `Already tried: On 3 May, rolled back the config; result: HTTP 200.\n${NOW_OK}`],
  ['early May', `Already tried: In early May, restarted the proxy; result: HTTP 200.\n${NOW_OK}`],
] as const) {
  test(`third review keeps a legitimate report: ${name}`, () => {
    expect(classifyIntent({ body, tag: 'problem', automated: true, layaProblemAssessment: positive }).action).toBe('pass');
  });
}
