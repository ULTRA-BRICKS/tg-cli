import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installSkill } from '../features/install-skill/install';
import { TAG_PILL_FALLBACK } from '../features/branding/emoji';

// installSkill() resolves everything from os.homedir(), which honors $HOME on
// posix — so we point HOME at a throwaway dir and assert on what it writes.
// Harness detection (`command -v claude` || dir exists) is satisfied because we
// create $HOME/.claude, so the blurb path is exercised without a real harness.

let TH: string;
let origHome: string | undefined;

beforeEach(() => {
  origHome = process.env.HOME;
  TH = mkdtempSync(join(tmpdir(), 'tg-installskill-'));
  mkdirSync(join(TH, '.claude', 'skills'), { recursive: true });
  process.env.HOME = TH;
});

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  rmSync(TH, { recursive: true, force: true });
});

test('writes SKILL.md, a blurb file, and the claude-skills symlink', () => {
  installSkill();
  expect(existsSync(join(TH, '.agents/skills/tg/SKILL.md'))).toBe(true);
  expect(existsSync(join(TH, '.agents/skills/.blurbs/tg.md'))).toBe(true);
  // ~/.claude/skills/tg -> ../../.agents/skills/tg
  expect(existsSync(join(TH, '.claude/skills/tg'))).toBe(true);
});

test('SKILL.md and the blurb advertise --tag / --title and the four canonical tags', () => {
  installSkill();
  const skill = readFileSync(join(TH, '.agents/skills/tg/SKILL.md'), 'utf8');
  // Flags are documented.
  expect(skill).toContain('--tag');
  expect(skill).toContain('--title');
  // The four lowercase-english canonical tags (the ONLY accepted form). No
  // Cyrillic aliases anymore, and no `question` (tg-cli#301): the skill must
  // never teach a tag tg refuses — it may only mention it as the removed word.
  for (const tag of ['answer', 'decision', 'problem', 'report']) {
    expect(skill).toContain(tag);
  }
  expect(skill).not.toContain('QUESTION');
  expect(skill).not.toContain('| question |');
  expect(skill).toContain('an open question for the user IS a decision request');
  for (const cyrillic of ['ОТВЕТ', 'РЕШЕНИЕ', 'ПРОБЛЕМА', 'ОТЧЁТ']) {
    expect(skill).not.toContain(`--tag ${cyrillic}`);
  }
  // The badge column matches the ACTUAL unicode fallback (colored dot + word),
  // not a stale decorative glyph — so the installed agent docs stay in sync with
  // what tg renders.
  for (const fallback of Object.values(TAG_PILL_FALLBACK)) {
    expect(skill).toContain(fallback); // e.g. "🔵 ANSWER"
  }
  // The body-is-never-pulled-up contract is stated.
  expect(skill.toLowerCase()).toContain('body');
  // The always-on blurb also mentions the flags + tags (agents that only see
  // the blurb still discover the convention) — lowercase-english only.
  const blurb = readFileSync(join(TH, '.agents/skills/.blurbs/tg.md'), 'utf8');
  expect(blurb).toContain('--tag');
  expect(blurb).toContain('--title');
  expect(blurb).toContain('answer');
  expect(blurb).toContain('report');
  expect(blurb).not.toContain('ОТВЕТ');
});

test('installed skill advertises synchronous generic human asks for harnesses without native question hooks', () => {
  installSkill();
  const skill = readFileSync(join(TH, '.agents/skills/tg/SKILL.md'), 'utf8');
  const blurb = readFileSync(join(TH, '.agents/skills/.blurbs/tg.md'), 'utf8');

  expect(skill).toContain('tg-ctl ask "');
  expect(skill).toContain('synchronous');
  expect(skill).toContain('without tmux');
  expect(skill).toContain('pi');
  expect(blurb).toContain('tg-ctl ask');
});

test('blurb in CLAUDE.md is idempotent and preserves existing content', () => {
  writeFileSync(join(TH, '.claude', 'CLAUDE.md'), '# personal\n\nmy notes\n');
  installSkill();
  installSkill(); // second run must not duplicate the marked block
  const body = readFileSync(join(TH, '.claude', 'CLAUDE.md'), 'utf8');
  expect(body).toContain('# personal');
  expect(body.match(/<!-- skill:tg -->/g)?.length).toBe(1);
});

test('SessionStart hook is added once and preserves unrelated settings', () => {
  writeFileSync(
    join(TH, '.claude', 'settings.json'),
    JSON.stringify(
      { model: 'opus', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] } },
      null,
      2,
    ),
  );
  installSkill();
  installSkill();
  const data = JSON.parse(readFileSync(join(TH, '.claude', 'settings.json'), 'utf8'));
  expect(data.model).toBe('opus'); // unrelated config preserved
  const groups = data.hooks.SessionStart;
  expect(groups.length).toBe(2); // existing + ours, not duplicated on re-run
  const hasExisting = groups.some((g: any) => g.hooks.some((h: any) => h.command === 'echo keep-me'));
  const hasOurs = groups.some((g: any) =>
    g.hooks.some((h: any) => String(h.command).includes('agent-tools-awareness')),
  );
  expect(hasExisting).toBe(true);
  expect(hasOurs).toBe(true);
});

test('an unparseable settings.json is left untouched, not clobbered', () => {
  writeFileSync(join(TH, '.claude', 'settings.json'), '{ not valid json');
  expect(() => installSkill()).not.toThrow();
  expect(readFileSync(join(TH, '.claude', 'settings.json'), 'utf8')).toBe('{ not valid json');
});
