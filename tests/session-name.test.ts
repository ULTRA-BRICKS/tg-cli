import { expect, test } from 'bun:test';
import { isBareWindowName, resolveSessionName, titleFromPaneTitle } from '../features/tg-ctl/session-name';

// The ONE session-name resolver (tg-cli#455/#75): tmux window primary, harness
// title secondary; outside tmux the harness title is primary.

test('in tmux: a real window name is primary and the harness title is secondary', () => {
  expect(
    resolveSessionName({ tmuxWindow: 'gc-sme-backlog', cwd: '/Users/u/xp/sme-archiving-gc', harnessTitle: 'Recover orphaned commits' }),
  ).toEqual({ primary: 'gc-sme-backlog', secondary: 'Recover orphaned commits' });
});

test('in tmux: the harness title never replaces the window name, even when it is the only title source', () => {
  expect(resolveSessionName({ tmuxWindow: 'ext', cwd: '/w/hyperide', paneTitle: 'π ⠴ Ship stacked PRs' })).toEqual({
    primary: 'ext',
    secondary: 'Ship stacked PRs',
  });
});

test('in tmux: a bare auto-rename window falls back to the cwd project, title stays secondary', () => {
  for (const bare of ['', '4', '2.1.207', 'zsh', 'node', 'bun', 'abduco']) {
    expect(resolveSessionName({ tmuxWindow: bare, cwd: '/Users/u/xp/rig-cli/', harnessTitle: 'Fix rig' })).toEqual({
      primary: 'rig-cli',
      secondary: 'Fix rig',
    });
  }
});

test('in tmux: bare window and no cwd → the harness title leads, then the bare window itself', () => {
  expect(resolveSessionName({ tmuxWindow: '4', cwd: '', harnessTitle: 'Fix rig' })).toEqual({ primary: 'Fix rig', secondary: null });
  expect(resolveSessionName({ tmuxWindow: '2.1.207', cwd: null })).toEqual({ primary: '2.1.207', secondary: null });
});

test('in tmux: a title equal to the window name is not repeated as secondary', () => {
  expect(resolveSessionName({ tmuxWindow: 'Rig', harnessTitle: 'rig' })).toEqual({ primary: 'Rig', secondary: null });
});

test('adapter title (omp endpoint/jsonl) outranks the pane title', () => {
  expect(resolveSessionName({ tmuxWindow: 'tg', harnessTitle: 'Adapter title', paneTitle: 'π > Stale pane title' }).secondary).toBe(
    'Adapter title',
  );
});

test('not in tmux: the harness title is primary, then the cwd project, then the fallback — never "no tmux"', () => {
  expect(resolveSessionName({ tmuxWindow: null, cwd: '/Users/u/xp/review-cli', harnessTitle: 'Fix review-cli' })).toEqual({
    primary: 'Fix review-cli',
    secondary: null,
  });
  expect(resolveSessionName({ cwd: '/Users/u/xp/review-cli' })).toEqual({ primary: 'review-cli', secondary: null });
  expect(resolveSessionName({ fallback: 'omp · 01a07d8e' })).toEqual({ primary: 'omp · 01a07d8e', secondary: null });
  expect(resolveSessionName({})).toEqual({ primary: '', secondary: null });
});

test('pane title: omp `π >` / `π <spinner>` prefixes and Claude Code ✳/spinner marks are stripped', () => {
  expect(titleFromPaneTitle('π > Fix TUI PR and review backlog')).toBe('Fix TUI PR and review backlog');
  expect(titleFromPaneTitle('π ⠹ Recover orphaned commits, verify PRs')).toBe('Recover orphaned commits, verify PRs');
  expect(titleFromPaneTitle('π ⠧ [ STT: hotkey and tui ]')).toBe('[ STT: hotkey and tui ]');
  expect(titleFromPaneTitle('✳ Fix header labels')).toBe('Fix header labels');
  expect(titleFromPaneTitle('⠐ Fix header labels')).toBe('Fix header labels');
  expect(titleFromPaneTitle('π > Груминг задач и roadmap tg-cli')).toBe('Груминг задач и roadmap tg-cli');
});

test('pane title: unmarked titles (host name, shell/mosh titles) and generic harness names are not session titles', () => {
  expect(titleFromPaneTitle('Ultras-MBP.local')).toBe('');
  expect(titleFromPaneTitle('[mosh] ultra@home: ~')).toBe('');
  expect(titleFromPaneTitle('πολύ καλό')).toBe(''); // a Greek word is not omp's prefix
  expect(titleFromPaneTitle('✳ Claude Code')).toBe('');
  expect(titleFromPaneTitle('π > ')).toBe('');
  expect(titleFromPaneTitle(null)).toBe('');
});

test('isBareWindowName: wrapper/launcher auto-rename names are bare, user labels are not', () => {
  expect(isBareWindowName('abduco')).toBe(true);
  expect(isBareWindowName('bun')).toBe(true);
  expect(isBareWindowName('gc-sme-backlog')).toBe(false);
  expect(isBareWindowName('omp-fixes')).toBe(false);
});
