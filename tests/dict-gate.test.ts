import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  checkDictionary,
  formatDictionaryHits,
  loadDictionary,
  resolveDictionaryPath,
  stripForDictionary,
  toUnicodeBoundaryPattern,
  type DictionaryField,
  type DictionaryFieldFormat,
  type DictionaryHit,
  type DictionaryRule,
} from '../features/cli/dict-gate';

// The fixture is a byte copy of the REAL ~/.claude/DICT.json (tg-cli#302): the
// tests below prove the gate against the shape Alex actually maintains, not a
// hand-made toy — in particular that STEM-based rules catch forms that appear
// nowhere in the pattern text.
const FIXTURE_PATH = join(import.meta.dir, 'fixtures', 'DICT.json');
const FIXTURE_RAW = readFileSync(FIXTURE_PATH, 'utf8');

function loadFixtureRules(): DictionaryRule[] {
  const loaded = loadDictionary(FIXTURE_RAW, FIXTURE_PATH);
  if (loaded.kind !== 'ok') throw new Error(`fixture did not load: ${JSON.stringify(loaded)}`);
  return loaded.rules;
}

const RULES = loadFixtureRules();

// The body is an HTML field unless said otherwise (the markup cases below are
// about HTML semantics); the title is always plain, as in the entrypoint.
function hitsFor(body: string, title?: string, format: DictionaryFieldFormat = 'html'): DictionaryHit[] {
  const fields: DictionaryField[] = [{ label: 'body', text: body, format }];
  if (title !== undefined) fields.unshift({ label: '--title', text: title, format: 'plain' });
  return checkDictionary(RULES, fields);
}

function ruleIds(hits: DictionaryHit[]): string[] {
  return hits.map((h) => h.ruleId);
}

describe('loadDictionary', () => {
  test('a missing file (null raw) disables the gate silently', () => {
    expect(loadDictionary(null, '/nowhere/DICT.json')).toEqual({ kind: 'disabled' });
  });

  test('the real DICT.json shape loads every rule with its id and replacement', () => {
    const parsed = JSON.parse(FIXTURE_RAW) as { rules: { id: string; replacement: string }[] };
    expect(RULES.length).toBe(parsed.rules.length);
    expect(RULES.length).toBeGreaterThan(5);
    expect(RULES.map((r) => r.id)).toEqual(parsed.rules.map((r) => r.id));
    expect(RULES.map((r) => r.replacement)).toEqual(parsed.rules.map((r) => r.replacement));
  });

  test('malformed JSON is an error naming the file', () => {
    const loaded = loadDictionary('{ not json', '/home/x/.claude/DICT.json');
    expect(loaded.kind).toBe('error');
    if (loaded.kind !== 'error') return;
    expect(loaded.message).toContain('/home/x/.claude/DICT.json');
    expect(loaded.message.toLowerCase()).toContain('json');
  });

  test('an invalid regex is an error naming the file AND the rule', () => {
    const raw = JSON.stringify({
      version: 1,
      rules: [
        { id: 'fine', pattern: 'ok', flags: 'iu', replacement: 'x', why: '' },
        { id: 'broken-rule', pattern: '(unclosed', flags: 'iu', replacement: 'x', why: '' },
      ],
    });
    const loaded = loadDictionary(raw, '/p/DICT.json');
    expect(loaded.kind).toBe('error');
    if (loaded.kind !== 'error') return;
    expect(loaded.message).toContain('/p/DICT.json');
    expect(loaded.message).toContain('broken-rule');
  });

  test('a rule missing a required field is an error naming the rule (fail closed)', () => {
    const raw = JSON.stringify({ version: 1, rules: [{ id: 'no-pattern', replacement: 'x' }] });
    const loaded = loadDictionary(raw, '/p/DICT.json');
    expect(loaded.kind).toBe('error');
    if (loaded.kind !== 'error') return;
    expect(loaded.message).toContain('no-pattern');
    expect(loaded.message).toContain('pattern');
  });

  test('a top level without a rules array is an error', () => {
    const loaded = loadDictionary('{"version": 1}', '/p/DICT.json');
    expect(loaded.kind).toBe('error');
    expect(loadDictionary('[]', '/p/DICT.json').kind).toBe('error');
  });

  test('a UTF-8 BOM before the JSON is tolerated (hand-edited files)', () => {
    const loaded = loadDictionary('\uFEFF' + FIXTURE_RAW, FIXTURE_PATH);
    expect(loaded.kind).toBe('ok');
  });

  test('an unknown "version" is an error naming the file; a missing one is accepted as v1', () => {
    const v2 = loadDictionary(JSON.stringify({ version: 2, rules: [] }), '/d/DICT.json');
    expect(v2.kind).toBe('error');
    if (v2.kind === 'error') {
      expect(v2.message).toContain('/d/DICT.json');
      expect(v2.message).toContain('version');
    }
    expect(loadDictionary(JSON.stringify({ rules: [] }), '/d/DICT.json').kind).toBe('ok');
  });

  test('a pattern with a control character (JSON "\\b" = backspace) is refused with the hint, not a silently dead rule', () => {
    const loaded = loadDictionary(
      JSON.stringify({ version: 1, rules: [{ id: 'dead', pattern: '\bпочтил\b', flags: 'iu', replacement: 'x', why: '' }] }),
      '/d/DICT.json',
    );
    expect(loaded.kind).toBe('error');
    if (loaded.kind === 'error') {
      expect(loaded.message).toContain('"dead"');
      expect(loaded.message).toContain('U+0008');
      expect(loaded.message).toContain('backspace');
    }
  });

  test('file flags carrying g/y are tolerated: the rule still reports every occurrence', () => {
    const loaded = loadDictionary(
      JSON.stringify({ version: 1, rules: [{ id: 'g', pattern: 'скамейк[а-яё]*', flags: 'giu', replacement: 'бенч', why: '' }] }),
      '/d/DICT.json',
    );
    expect(loaded.kind).toBe('ok');
    if (loaded.kind === 'ok') {
      const hits = checkDictionary(loaded.rules, [{ label: 'body', text: 'скамейка и скамейки', format: 'plain' }]);
      expect(hits).toHaveLength(2);
    }
  });

  test('an empty rules array is a valid, no-op dictionary', () => {
    const loaded = loadDictionary('{"version": 1, "rules": []}', '/p/DICT.json');
    expect(loaded).toEqual({ kind: 'ok', rules: [] });
  });
});

describe('\\b is read as a Unicode word boundary (the file is authored Python-style)', () => {
  test('a raw JS \\b never matches next to Cyrillic — the translation is load-bearing', () => {
    const raw = '\\bпочтил\\b';
    expect(new RegExp(raw, 'iu').test('он почтил баг')).toBe(false);
    expect(new RegExp(toUnicodeBoundaryPattern(raw), 'iu').test('он почтил баг')).toBe(true);
  });

  test('the translated boundary still refuses a match INSIDE a longer word', () => {
    const re = new RegExp(toUnicodeBoundaryPattern('\\bсел\\b'), 'iu');
    expect(re.test('весело')).toBe(false);
    expect(re.test('сел')).toBe(true);
    expect(re.test('он сел.')).toBe(true);
  });

  test('\\b inside a character class (backspace) and an escaped backslash are left alone', () => {
    expect(toUnicodeBoundaryPattern('[\\b]')).toBe('[\\b]');
    expect(toUnicodeBoundaryPattern('a\\\\b')).toBe('a\\\\b');
    expect(toUnicodeBoundaryPattern('\\B')).toBe('\\B');
  });
});

describe('stripForDictionary', () => {
  test('removes the CONTENTS of <code> and <pre> blocks (quoting a banned word is legitimate)', () => {
    expect(stripForDictionary('слово <code>почтил</code> запрещено', 'html')).not.toContain('почтил');
    expect(stripForDictionary('<pre>\nпочтил\n</pre> ок', 'html')).not.toContain('почтил');
    expect(stripForDictionary('<pre><code class="language-ts">скамейка</code></pre>', 'html')).not.toContain(
      'скамейка',
    );
    expect(stripForDictionary('<CODE>почтил</CODE>', 'html')).not.toContain('почтил');
  });

  test('inline tags are removed so a tag boundary cannot split a word', () => {
    expect(stripForDictionary('почт<b>ил</b>', 'html')).toBe('почтил');
    expect(stripForDictionary('<i>сел</i> в DOM', 'html')).toBe('сел в DOM');
  });

  test('block tags separate words instead of gluing them', () => {
    expect(stripForDictionary('сел<br>в', 'html')).toMatch(/^сел\s+в$/);
    expect(stripForDictionary('<p>сел</p><p>в</p>', 'html')).toMatch(/сел\s+в/);
  });

  test('HTML entities (named and numeric) are decoded before matching', () => {
    expect(stripForDictionary('почт&#1080;л', 'html')).toBe('почтил');
    expect(stripForDictionary('почт&#x438;л', 'html')).toBe('почтил');
    expect(stripForDictionary('a &lt; b &amp; c', 'html')).toBe('a < b & c');
  });

  test('a PLAIN field is returned verbatim — Telegram renders it literally, so nothing hides', () => {
    for (const text of ['<скамейка>', 'слово <code>почтил</code>', 'почт&#1080;л', 'a <b', '<pre>сел</pre>']) {
      expect(stripForDictionary(text, 'plain')).toBe(text);
    }
  });
});

describe('checkDictionary — stem-based catching with the real rules', () => {
  const POCHT_FORMS = ['почтил', 'почтила', 'почтили', 'почтит', 'почтится', 'почтётся', 'почтется', 'почтить', 'почтённый', 'почтён', 'почтена'];
  for (const form of POCHT_FORMS) {
    test(`refuses the почт- verb form "${form}" (not literally listed anywhere)`, () => {
      const hits = hitsFor(`Я ${form} баг в парсере.`);
      expect(ruleIds(hits)).toContain('pochtit-as-fix');
      expect(hits[0].matched.toLowerCase()).toBe(form);
    });
  }

  test('refuses an UPPERCASE form too (flags iu)', () => {
    expect(ruleIds(hitsFor('ПОЧТИЛ баг'))).toContain('pochtit-as-fix');
  });

  test('passes the legitimate words почти / почта / почтение', () => {
    expect(hitsFor('почти готово, почта пришла, с почтением')).toEqual([]);
  });

  test('passes the correct fix wording: починен / починил / патчил', () => {
    expect(hitsFor('Баг починен, я его починил и патчил тесты.')).toEqual([]);
  });

  test('refuses "скамья" and "скамейка" forms (stem rule, no word list)', () => {
    expect(ruleIds(hitsFor('провайдер на скамье запасных'))).toContain('skameyka-for-bench');
    expect(ruleIds(hitsFor('посадили на скамейку'))).toContain('skameyka-for-bench');
    expect(ruleIds(hitsFor('скамья'))).toContain('skameyka-for-bench');
  });

  test('passes бенч / бенчмарк', () => {
    expect(hitsFor('прогнал бенч, бенчмарк зелёный')).toEqual([]);
  });

  test('refuses "сел в DOM", "села", "легла", "садится" (sit/lie for apply)', () => {
    for (const s of ['стиль сел в DOM', 'правка села', 'правка легла', 'стиль садится в DOM']) {
      expect(ruleIds(hitsFor(s))).toContain('sit-lie-for-apply');
    }
  });

  test('passes "применяется" and words that merely CONTAIN сел/лёг as a substring', () => {
    expect(hitsFor('стиль применяется в DOM; весело; поселок; уголёк')).toEqual([]);
  });

  test('refuses "landing"/"landed" inside Russian text (only_if_cyrillic)', () => {
    expect(ruleIds(hitsFor('после landing фикса всё ок'))).toContain('land-landing-in-russian');
    expect(ruleIds(hitsFor('PR landed, проверяй'))).toContain('land-landing-in-russian');
  });

  test('passes "the fix landed" in a message with NO Cyrillic', () => {
    expect(hitsFor('the fix landed on main, landing page updated')).toEqual([]);
  });

  test('only_if_cyrillic is judged over the WHOLE message: an English title over a Russian body is refused', () => {
    const hits = hitsFor('всё готово, проверяй', 'Landing done');
    expect(ruleIds(hits)).toContain('land-landing-in-russian');
    expect(hits[0].field).toBe('--title');
  });

  test('checks the --title as well as the body and reports every hit', () => {
    const hits = hitsFor('Я почтил баг, а стиль сел в DOM.', 'Скамейка запасных');
    expect(ruleIds(hits)).toEqual(
      expect.arrayContaining(['skameyka-for-bench', 'pochtit-as-fix', 'sit-lie-for-apply']),
    );
    expect(hits.filter((h) => h.field === '--title')).toHaveLength(1);
    expect(hits.filter((h) => h.field === 'body')).toHaveLength(2);
  });

  test('a banned word inside <code>/<pre> is ignored; the same word outside is caught', () => {
    expect(hitsFor('запрещено слово <code>почтил</code>, пиши починил')).toEqual([]);
    expect(ruleIds(hitsFor('<code>ok</code> я почтил'))).toContain('pochtit-as-fix');
  });

  test('a word split by an inline tag is caught', () => {
    expect(ruleIds(hitsFor('я почт<b>ил</b> баг'))).toContain('pochtit-as-fix');
  });

  test('a word hidden behind numeric entities is caught', () => {
    expect(ruleIds(hitsFor('я почт&#1080;л баг'))).toContain('pochtit-as-fix');
  });

  test('PLAIN format: a banned word between < and > or inside <code> is delivered verbatim, so it is refused', () => {
    expect(ruleIds(hitsFor('фикс: <скамейка запасных> влит', undefined, 'plain'))).toContain('skameyka-for-bench');
    expect(ruleIds(hitsFor('слово <code>почтил</code> запрещено', undefined, 'plain'))).toContain('pochtit-as-fix');
    expect(ruleIds(hitsFor('бенч <a скамейка', undefined, 'plain'))).toContain('skameyka-for-bench');
    // The same markup under HTML stays exempt — the two formats are distinct.
    expect(hitsFor('слово <code>почтил</code> запрещено', undefined, 'html')).toEqual([]);
  });

  test('PLAIN format: an entity is literal text, so it neither hides nor forms a word', () => {
    expect(hitsFor('почт&#1080;л', undefined, 'plain')).toEqual([]);
  });

  test('only_if_cyrillic is judged on the RAW text: Cyrillic quoted in <code> still counts', () => {
    const hits = hitsFor('see <code>правку</code> for details', 'Landing done');
    expect(ruleIds(hits)).toContain('land-landing-in-russian');
  });

  test('English flattery is refused regardless of script', () => {
    expect(ruleIds(hitsFor("You're absolutely right, shipping now"))).toContain('sycophancy-en');
    expect(ruleIds(hitsFor('Great question!'))).toContain('sycophancy-en');
  });

  test('each hit carries ~20 chars of context around the match and the replacement', () => {
    const [hit] = hitsFor('Сегодня утром я почтил баг в парсере и всё проверил ещё раз.');
    expect(hit.ruleId).toBe('pochtit-as-fix');
    expect(hit.matched).toBe('почтил');
    expect(hit.context).toContain('почтил');
    expect(hit.context.length).toBeLessThanOrEqual('почтил'.length + 40 + 2);
    expect(hit.context).toContain('утром я почтил баг в');
    expect(hit.replacement).toContain('починил');
  });
});

describe('formatDictionaryHits', () => {
  test('refuses to format an empty hit list (a refusal with nothing to show is a caller bug)', () => {
    expect(() => formatDictionaryHits([], FIXTURE_PATH)).toThrow();
  });

  test('names every rule, the matched text with context, the replacement, and the file path', () => {
    const hits = hitsFor('Я почтил баг.', 'Скамейка');
    const out = formatDictionaryHits(hits, FIXTURE_PATH);
    expect(out).toContain('pochtit-as-fix');
    expect(out).toContain('skameyka-for-bench');
    expect(out).toContain('почтил');
    expect(out).toContain('Скамейка');
    expect(out).toContain('починил');
    expect(out).toContain('бенч');
    expect(out).toContain('--title');
    expect(out).toContain(FIXTURE_PATH);
  });
});

describe('resolveDictionaryPath', () => {
  test('TG_DICT_PATH wins over HOME and is marked explicit', () => {
    expect(resolveDictionaryPath({ TG_DICT_PATH: '/x/d.json', HOME: '/home/u' })).toEqual({ path: '/x/d.json', explicit: true });
  });
  test('defaults to ~/.claude/DICT.json under HOME, not explicit', () => {
    expect(resolveDictionaryPath({ HOME: '/home/u' })).toEqual({ path: join('/home/u', '.claude', 'DICT.json'), explicit: false });
  });
  test('an EMPTY TG_DICT_PATH falls back to HOME', () => {
    expect(resolveDictionaryPath({ TG_DICT_PATH: '', HOME: '/home/u' })?.path).toBe(join('/home/u', '.claude', 'DICT.json'));
  });
  test('no override and no HOME → null (gate disabled), never a literal "~" path', () => {
    expect(resolveDictionaryPath({})).toBeNull();
  });
});
