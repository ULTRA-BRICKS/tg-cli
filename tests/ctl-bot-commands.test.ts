import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BOT_COMMANDS,
  botCommandNames,
  MAX_COMMAND_LEN,
  MAX_DESCRIPTION_LEN,
  validateBotCommands,
  type BotCommand,
} from '../features/tg-ctl/bot-commands';

// The published menu (setMyCommands) must (1) satisfy Telegram's constraints and
// (2) stay in lockstep with the slash-commands the bot actually handles, so a
// newly-handled command can't silently miss the "/" autocomplete.

test('BOT_COMMANDS satisfies Telegram setMyCommands constraints', () => {
  expect(() => validateBotCommands()).not.toThrow();
  for (const c of BOT_COMMANDS) {
    expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(c.command.length).toBeLessThanOrEqual(MAX_COMMAND_LEN);
    expect(c.command).not.toStartWith('/'); // Telegram wants the name WITHOUT the slash
    // Code points (matching validateBotCommands), not UTF-16 units.
    expect([...c.description].length).toBeGreaterThanOrEqual(1);
    expect([...c.description].length).toBeLessThanOrEqual(MAX_DESCRIPTION_LEN);
  }
  expect(BOT_COMMANDS.length).toBeGreaterThan(0);
  expect(BOT_COMMANDS.length).toBeLessThanOrEqual(100);
});

test('validateBotCommands rejects malformed lists', () => {
  expect(() => validateBotCommands([])).toThrow(/empty/);
  expect(() => validateBotCommands([{ command: 'Bad', description: 'x' }])).toThrow(/invalid command name/);
  expect(() => validateBotCommands([{ command: '/agent', description: 'x' }])).toThrow(/invalid command name/);
  // Too long (33 chars) trips the length bound, not a charset issue.
  expect(() => validateBotCommands([{ command: 'a'.repeat(33), description: 'x' }])).toThrow(/invalid command name/);
  expect(() => validateBotCommands([{ command: 'ok', description: '' }])).toThrow(/description/);
  expect(() => validateBotCommands([{ command: 'ok', description: 'y'.repeat(257) }])).toThrow(/description/);
  expect(() =>
    validateBotCommands([
      { command: 'dup', description: 'a' },
      { command: 'dup', description: 'b' },
    ]),
  ).toThrow(/duplicate/);
  // Over Telegram's 100-command cap.
  const tooMany: BotCommand[] = Array.from({ length: 101 }, (_, i) => ({ command: `c${i}`, description: 'x' }));
  expect(() => validateBotCommands(tooMany)).toThrow(/100/);
});

test('the menu carries the user-facing routing commands', () => {
  const names = botCommandNames();
  // /agent is the headline of the ask ("/agent и другие команды добавь в меню").
  expect(names).toContain('agent');
  expect(names).toContain('new');
  expect(names).toContain('stop');
  expect(names).toContain('kill');
  expect(names).toContain('status');
});

// Commands `textAction` handles via `cmd === '/x'` but that are deliberately NOT
// published (an admin/hidden command). Empty today — every handled command is a
// menu command. Keeping it explicit means a future hidden command is a one-line,
// reviewed addition here, not a silent guard rewrite.
const HANDLED_BUT_HIDDEN = new Set<string>();

// GUARD: scrape the slash-commands `textAction` (features/tg-ctl/updates.ts)
// recognizes — every `cmd === '/<name>'` branch — and assert (1) the menu only
// publishes commands the bot actually handles, and (2) every handled command is
// EITHER published OR explicitly listed as hidden. This is the seam the CTO
// worried about: a newly-handled command can't silently miss the menu, and a
// stale menu entry for a removed command is caught too — WITHOUT forcing every
// handled command into the menu (passthrough/admin commands stay out by design).
test('the menu and textAction never drift apart', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'features', 'tg-ctl', 'updates.ts'), 'utf8');
  const fnStart = src.search(/\n(?:export\s+)?(?:async\s+)?function textAction\(/);
  expect(fnStart).toBeGreaterThanOrEqual(0);
  // textAction's body ends at the next top-level declaration — match `function`,
  // `async function`, `export function`, … (not just a bare `\nfunction `), so a
  // sibling declared with any of those modifiers can't leak its cmd === '/x'
  // branches into the scrape and skew the comparison (review hardening, #68).
  const after = src.slice(fnStart + 1);
  const nextDecl = after.search(/\n(?:export\s+)?(?:async\s+)?function /);
  const body = nextDecl === -1 ? after : after.slice(0, nextDecl);

  const handled = new Set<string>();
  for (const m of body.matchAll(/cmd === ['"]\/([a-z0-9_]+)['"]/g)) handled.add(m[1]);
  expect(handled.size).toBeGreaterThan(0); // sanity: we actually parsed branches

  const published = new Set(botCommandNames());

  // (1) Every PUBLISHED command must be one the bot actually handles — no menu
  // entry for a command that does nothing.
  for (const name of published) {
    expect(handled.has(name)).toBe(true);
  }
  // (2) Every HANDLED command must be either published or explicitly hidden —
  // no handled command silently missing from the menu.
  for (const name of handled) {
    if (HANDLED_BUT_HIDDEN.has(name)) continue;
    expect(published.has(name)).toBe(true);
  }
});

// Type-level sanity: BotCommand shape is what setMyCommands expects.
test('BotCommand entries carry exactly command + description', () => {
  for (const c of BOT_COMMANDS) {
    const keys = Object.keys(c as BotCommand).sort();
    expect(keys).toEqual(['command', 'description']);
  }
});
