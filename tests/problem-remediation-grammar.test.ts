import { describe, expect, test } from 'bun:test';
import { validateProblemRemediation } from '../features/cli/problem-remediation';

const DONE = 'Already tried: Checked browser permissions; result: permission denied.';
const NOW = 'Doing now: Reopening the chat.';

const passes = (body: string): boolean => validateProblemRemediation(body).ok;

describe('ordinary concise reports are accepted', () => {
  test('Russian one-line report with a single named object', () => {
    expect(passes('Проблема: чат не открыт. Уже сделал: Перезапустил браузер; результат: вкладка не появилась. Сейчас делаю: Открываю чат вручную.')).toBe(true);
  });
  test('English one-line report with a single named object', () => {
    expect(passes('Already tried: Restarted Chrome; result: the tab is still missing. Doing now: Reopening the chat.')).toBe(true);
  });
  test('an exit status is an observed result', () => {
    expect(passes(`Already tried: Ran check 1; result: exit 1.\n${NOW}`)).toBe(true);
  });
  test('a purpose clause that starts with "if" does not void the action after it', () => {
    expect(passes(`Already tried: To check if the proxy works, I curled /health; result: HTTP 503.\n${NOW}`)).toBe(true);
    expect(passes(`${DONE}\nDoing now: To see whether the leak persists, restarting node-2 with heap profiling.`)).toBe(true);
  });
  for (const result of [
    'it is not available (HTTP 503)',
    'unknown host',
    'пока не отвечает',
    'ещё не поднялся через 5 минут',
    'pending requests timed out',
    'the job is still pending after 20 minutes',
    'unknown host api.internal',
    'not responding',
  ]) {
    test(`an observed negative result is not a deferral: ${result}`, () => {
      expect(passes(`Already tried: Restarted the worker; result: ${result}.\n${NOW}`)).toBe(true);
    });
  }
});

describe('placeholders, promises and negations stay rejected', () => {
  for (const result of ['unknown', 'pending', 'will know later', 'узнаю позже', 'not yet known', 'TBD']) {
    test(`a deferred result is not an observation: ${result}`, () => {
      expect(passes(`Already tried: Restarted the worker; result: ${result}.\n${NOW}`)).toBe(false);
    });
  }
  for (const current of [
    'As of 10:30 we are not<br>restarting node-2.',
    "I won't, since approval is missing, be restarting node-2.",
    'I am not, because of the freeze, restarting node-2.',
    "I'm not sure we are still restarting node-2.",
    'It is not true that we are restarting node-2.',
    'If it works, checking node-2.',
  ]) {
    test(`a negated, doubted or conditional current action does not count: ${current}`, () => {
      expect(passes(`${DONE}\nDoing now: ${current}`)).toBe(false);
    });
  }
  test('a doubted past action does not count', () => {
    expect(passes(`Already tried: I'm not sure I restarted the worker; result: still 401.\n${NOW}`)).toBe(false);
  });
  test('a promise of work is not work', () => {
    expect(passes(`Already tried: I will restart Chrome; result: the tab is missing.\n${NOW}`)).toBe(false);
  });
});

describe('validation cost is bounded', () => {
  const body = (lines: number, line: (index: number) => string): string =>
    ['Already tried:', ...Array.from({ length: lines }, (_, index) => line(index)), 'Doing now: Checking browser permissions.'].join('\n');

  for (const [name, line] of [
    ['actions with results', (index: number) => `Ran check ${index}; result: exit 1.`],
    ['actions without results', (index: number) => `Checked service ${index}.`],
    ['results without actions', (index: number) => `result: exit ${index}`],
    ['literals', (index: number) => `Ran \`check ${index}\`; result: \`exit ${index}\`.`],
  ] as const) {
    test(`a 32 KiB body of ${name} validates within a second`, () => {
      const text = body(Math.ceil(32768 / (line(0).length + 1)), line);
      expect(text.length).toBeGreaterThanOrEqual(32768);
      const started = performance.now();
      validateProblemRemediation(text);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  }
});
