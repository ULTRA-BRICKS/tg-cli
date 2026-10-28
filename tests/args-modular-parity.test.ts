// Golden parity net for the parseArgs decomposition (tg-cli#817). Record mode
// (ARGS_PARITY_RECORD=1) writes the current parser results; replay mode asserts
// byte-identical output, including key order and explicitly-undefined fields.
import { beforeAll, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs, type ParseOptions } from '../features/cli/args';
import { tempDir } from './helpers/test-temp';

const GOLDEN = join(import.meta.dir, 'fixtures/args-modular/parse-golden.json');
const RECORD = process.env.ARGS_PARITY_RECORD === '1';

interface Case {
  name: string;
  args: string[];
  opts?: ParseOptions;
}

const FULL_DECISION =
  'Context: we need to pick a store.\\n<h3>Options</h3><table><tr><td>A</td><td>pro</td></tr></table>\\nRecommendation: A.\\nWhere to look: src/a.ts:10';

const CASES: Case[] = [
  { name: 'empty', args: [] },
  { name: 'help short', args: ['-h'] },
  { name: 'help long late', args: ['hello', '--bogus', '--help'] },
  { name: 'version', args: ['--version'] },
  { name: 'help beats version', args: ['-v', '-h'] },
  { name: 'version beats info', args: ['--detect-model', '-v'] },
  { name: 'ls-emoji-helpers', args: ['x', '--ls-emoji-helpers'] },
  { name: 'detect-model', args: ['--detect-model'] },
  { name: 'detect-agent', args: ['--detect-agent'] },
  { name: 'session-topic', args: ['--session-topic'] },
  { name: 'session-id', args: ['--session-id'] },
  { name: 'format-help', args: ['--format-help'] },
  { name: 'info order: emoji before model', args: ['--detect-model', '--ls-emoji-helpers'] },
  { name: 'info order: model before agent', args: ['--detect-agent', '--detect-model'] },
  { name: 'info order: agent before topic', args: ['--session-topic', '--detect-agent'] },
  { name: 'info order: topic before id', args: ['--session-id', '--session-topic'] },
  { name: 'info order: id before format-help', args: ['--format-help', '--session-id'] },
  { name: 'info beats unknown flag', args: ['--zzz', '--session-id'] },
  { name: 'plain text', args: ['hello', 'world'] },
  { name: 'format html', args: ['--format', 'html', 'hi'] },
  { name: 'format plain', args: ['--format', 'plain', 'hi'] },
  { name: 'format missing', args: ['--format'] },
  { name: 'format dashed', args: ['--format', '--tag'] },
  { name: 'format bad', args: ['--format', 'md', 'hi'] },
  { name: 'title', args: ['--title', 'Header', 'body'] },
  { name: 'title only', args: ['--title', 'Header'] },
  { name: 'title missing', args: ['--title'] },
  { name: 'title dashed', args: ['--title', '--tag', 'x'] },
  { name: 'title single dash ok', args: ['--title', '-x'] },
  { name: 'title msgref', args: ['--title', 'see tg#1234', 'b'] },
  { name: 'title msgref feature off', args: ['--title', 'see tg#1234', 'b'], opts: { msgrefAutolink: false } },
  { name: 'title ticket', args: ['--title', 'fix HYP-123 now', 'b'] },
  { name: 'title ticket compound', args: ['--title', 'HYP-1/2/3', 'b'] },
  { name: 'title ticket feature off', args: ['--title', 'fix HYP-123 now', 'b'], opts: { ticketAutolink: false } },
  { name: 'title github issue ok', args: ['--title', 'closes #42', 'b'] },
  { name: 'tag status', args: ['--tag', 'status', 'b'] },
  { name: 'tag padded', args: ['--tag', ' status ', 'b'] },
  { name: 'tag missing', args: ['--tag'] },
  { name: 'tag dashed', args: ['--tag', '--title'] },
  { name: 'tag uppercase', args: ['--tag', 'ANSWER', 'b'] },
  { name: 'tag unknown', args: ['--tag', 'nonsense', 'b'] },
  { name: 'tag cyrillic', args: ['--tag', 'ответ', 'b'] },
  { name: 'answer without reply-to', args: ['--tag', 'answer', 'b'] },
  { name: 'answer padded without reply-to', args: ['--tag', ' answer ', 'b'] },
  { name: 'answer with reply-to', args: ['--tag', 'answer', '--reply-to', '12', 'b'] },
  { name: 'answer terminal-question', args: ['--tag', 'answer', '--terminal-question', 'b'] },
  { name: 'terminal-question alone', args: ['--terminal-question', 'b'] },
  { name: 'decision plain bare', args: ['--tag', 'decision', 'pick one?'] },
  { name: 'decision html bare', args: ['--tag', 'decision', '--format', 'html', 'pick one?'] },
  { name: 'decision html full', args: ['--tag', 'decision', '--format', 'html', FULL_DECISION] },
  { name: 'decision plain full', args: ['--tag', 'decision', FULL_DECISION] },
  { name: 'decision table', args: ['--tag', 'decision', '--table'] },
  { name: 'decision body text', args: ['--tag', 'decision'], opts: { bodyText: 'stdin decision body' } },
  { name: 'subagent', args: ['--subagent', ' fixer ', 'b'] },
  { name: 'agent alias', args: ['--agent', 'fixer', 'b'] },
  { name: 'subagent missing', args: ['--subagent'] },
  { name: 'agent missing', args: ['--agent'] },
  { name: 'subagent dashed', args: ['--subagent', '--tag'] },
  { name: 'subagent blank', args: ['--subagent', '   ', 'b'] },
  { name: 'agent blank', args: ['--agent', '', 'b'] },
  { name: 'subagent only', args: ['--subagent', 'x'] },
  { name: 'with-original', args: ['--with-original', 'b'] },
  { name: 'no-pdf', args: ['--no-pdf', 'b'] },
  { name: 'both pdf flags', args: ['--no-pdf', '--with-original', 'b'] },
  { name: 'pdf-device', args: ['--pdf-device', 'a4', 'b'] },
  { name: 'pdf-device missing', args: ['--pdf-device'] },
  { name: 'pdf-device dashed', args: ['--pdf-device', '--x'] },
  { name: 'reply-to', args: ['--reply-to', '42'] },
  { name: 'reply-to only is not empty', args: ['--reply-to', '7'] },
  { name: 'reply-to missing', args: ['--reply-to'] },
  { name: 'reply-to dashed', args: ['--reply-to', '--tag'] },
  { name: 'reply-to zero', args: ['--reply-to', '0'] },
  { name: 'reply-to leading zero', args: ['--reply-to', '012'] },
  { name: 'reply-to text', args: ['--reply-to', 'abc'] },
  { name: 'reply-to negative', args: ['--reply-to', '-3'] },
  { name: 'topic', args: ['--topic', '99', 'b'] },
  { name: 'topic missing', args: ['--topic'] },
  { name: 'topic dashed', args: ['--topic', '--x'] },
  { name: 'topic zero', args: ['--topic', '0'] },
  { name: 'topic text', args: ['--topic', 'general'] },
  { name: 'topic only is empty', args: ['--topic', '5'] },
  { name: 'session', args: ['--session', 'omp:abc123', 'b'] },
  { name: 'session missing', args: ['--session'] },
  { name: 'session dashed', args: ['--session', '--x'] },
  { name: 'session whitespace', args: ['--session', 'a b'] },
  { name: 'session empty string', args: ['--session', ''] },
  { name: 'table', args: ['--table'] },
  { name: 'table with title', args: ['--table', '--title', 'T'] },
  { name: 'dry-run', args: ['--dry-run', 'b'] },
  { name: 'dry-run only is empty', args: ['--dry-run'] },
  { name: 'automated', args: ['--automated', 'b'] },
  { name: 'all booleans', args: ['--table', '--dry-run', '--automated', '--terminal-question', '--with-original', '--no-pdf'] },
  { name: 'everything', args: ['--format', 'html', '--title', 'T', '--tag', 'status', '--subagent', 's', '--pdf-device', 'a4', '--reply-to', '3', '--topic', '4', '--session', 'sid', '--dry-run', '--automated', 'body', 'text'] },
  { name: 'unknown flag', args: ['--wat'] },
  { name: 'unknown short flag', args: ['-z', 'b'] },
  { name: 'unknown after text', args: ['hello', '--wat'] },
  { name: 'lone dash', args: ['-'] },
  { name: 'unknown before real flag', args: ['--wat', '--title', 'x'] },
  { name: 'error order: first error wins', args: ['--format', 'md', '--title'] },
  { name: 'bodyText only', args: [], opts: { bodyText: 'from stdin' } },
  { name: 'bodyText appended', args: ['a', 'b'], opts: { bodyText: 'c --tag x' } },
  { name: 'bodyText whitespace ignored', args: [], opts: { bodyText: '   \n ' } },
  { name: 'bodyText dashed stays text', args: [], opts: { bodyText: '- a' } },
  { name: 'bodyText with title', args: ['--title', 'T'], opts: { bodyText: 'body' } },
  { name: 'caption trimmed edges', args: ['  a  ', 'b  '] },
  { name: 'caption interior newline', args: ['a\nb'], opts: { bodyText: 'x\n\ny  ' } },
  { name: 'photo missing', args: ['--photo'] },
  { name: 'file missing', args: ['--file'] },
  { name: 'file dashed nonexistent', args: ['--file', '-nope.png'] },
  { name: 'photo dashed nonexistent', args: ['--photo', '--nope.png'] },
  { name: 'photo dashed existing file', args: ['--photo', '-dash.png', 'cap'] },
  { name: 'file dashed existing file', args: ['--file', '-dash.png'] },
  { name: 'file double dash existing file', args: ['--file', '--ddash.txt'] },
  { name: 'photo plain', args: ['--photo', 'a.png', 'cap'] },
  { name: 'file plain', args: ['--file', 'notes.txt'] },
  { name: 'photo and file order', args: ['--file', 'a.txt', '--photo', 'b.png', '--file', 'c.txt'] },
  { name: 'denylist env', args: ['--file', '.env'] },
  { name: 'denylist key', args: ['--photo', 'id_rsa'] },
  { name: 'denylist off', args: ['--file', '.env'], opts: { attachDenylist: false } },
  { name: 'denylist after valid', args: ['--file', 'a.txt', '--file', '.env'] },
  { name: 'linespec attach', args: ['--file', 'src/a.ts', 'see src/a.ts:42-50'] },
  { name: 'linespec attach col', args: ['--file', 'src/a.ts', 'see src/a.ts:42:7'] },
  { name: 'linespec wrapped punctuation', args: ['--file', 'src/a.ts', 'see (src/a.ts:42).'] },
  { name: 'linespec backticks', args: ['--file', 'src/a.ts', 'see `src/a.ts:9`'] },
  { name: 'linespec first wins', args: ['--file', 'src/a.ts', 'src/a.ts:1 src/a.ts:2'] },
  { name: 'linespec two items same path', args: ['--file', 'src/a.ts', '--file', './src/a.ts', 'src/a.ts:1 src/a.ts:2'] },
  { name: 'linespec no explicit item', args: ['see src/a.ts:42'] },
  { name: 'linespec other file', args: ['--file', 'src/b.ts', 'see src/a.ts:42'] },
  { name: 'linespec tilde', args: ['--file', '~/a.ts', 'see ~/a.ts:5'] },
  { name: 'linespec absolute vs relative', args: ['--file', '/work/a.ts', 'see ./a.ts:5'] },
  { name: 'linespec dotdot', args: ['--file', '/work/x/../a.ts', 'see /work/a.ts:5'] },
  { name: 'linespec from bodyText', args: ['--file', 'src/a.ts'], opts: { bodyText: 'see src/a.ts:77' } },
  { name: 'photo linespec', args: ['--photo', 'p.png', 'p.png:3'] },
  { name: 'file only is not empty', args: ['--file', 'a.txt'] },
];

function serialize(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (val === undefined ? '__undefined__' : val), 2);
}

let dir: string;

beforeAll(() => {
  dir = tempDir('args-parity-');
  writeFileSync(join(dir, '-dash.png'), 'x');
  writeFileSync(join(dir, '--ddash.txt'), 'x');
});

function run(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of CASES) out[c.name] = serialize(parseArgs(c.args, dir, '/home/parity', c.opts));
  return out;
}

describe('parseArgs modular parity', () => {
  test('case names are unique', () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  test(RECORD ? 'record golden' : 'matches golden', async () => {
    const actual = run();
    if (RECORD) {
      await Bun.write(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    const golden = (await Bun.file(GOLDEN).json()) as Record<string, string>;
    expect(Object.keys(actual)).toEqual(Object.keys(golden));
    for (const name of Object.keys(golden)) expect(actual[name]).toBe(golden[name]);
  });
});
