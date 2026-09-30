import { expect, test } from 'bun:test';
import { agentNameFromDisplayLine } from '../features/tg-ctl/agent-name';

test('agentNameFromDisplayLine parses window_name<TAB>pane_path', () => {
  expect(agentNameFromDisplayLine('rig\t/Users/u/xp/rig-cli\n')).toBe('rig');
  // trailing newline stripped, tab delimiter preserved
  expect(agentNameFromDisplayLine('api-bot\t/Users/u/work/api')).toBe('api-bot');
});

test('agentNameFromDisplayLine: EMPTY window name keeps the path in the right slot (regression)', () => {
  // A blanket .trim() would eat the leading tab and shift the path into the window-name slot,
  // yielding the path as the label; the cwd fallback must win instead.
  expect(agentNameFromDisplayLine('\t/Users/u/work/ext\n')).toBe('ext');
  expect(agentNameFromDisplayLine('\t/a/b/c')).toBe('c');
});

test('agentNameFromDisplayLine: a bare/auto-named window falls back to the cwd project', () => {
  expect(agentNameFromDisplayLine('node\t/Users/u/xp/rig-cli\n')).toBe('rig-cli');
});

test('agentNameFromDisplayLine: no tab → lone window name, both empty → null', () => {
  expect(agentNameFromDisplayLine('solo\n')).toBe('solo');
  expect(agentNameFromDisplayLine('\t\n')).toBeNull();
  expect(agentNameFromDisplayLine('')).toBeNull();
});
