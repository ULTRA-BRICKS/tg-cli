// Tests for the flat-chat `/new` command PURE module (issue #27): the arg parser, the
// parents-aware LRU/MRU dir ranker, name-uniqueness, and the inline-button keyboards/callbacks.

import { describe, expect, test } from 'bun:test';
import {
  MAX_NEW_DIR_CHOICES,
  NEW_DIR_CALLBACK_PREFIX,
  NEW_PRIVATE_TOPIC_FALLBACK_CALLBACK_PREFIX,
  NEW_PRIVATE_TOPIC_FALLBACK_CANCEL,
  NEW_PRIVATE_TOPIC_FALLBACK_CONTINUE,
  NEW_MODEL_CALLBACK_PREFIX,
  buildNewDirKeyboard,
  buildNewHarnessKeyboard,
  buildNewModelKeyboard,
  buildNewPrivateTopicFallbackKeyboard,
  nameCollides,
  parentDirs,
  parseNewCommand,
  parseNewDirCallback,
  parseNewHarnessCallback,
  parseNewModelCallback,
  parseNewPrivateTopicFallbackCallback,
  rankNewDirChoices,
  resolveHarnessToken,
  resolveModelToken,
  sessionTargetArgs,
  parseNewRetryCallback,
  buildNewRetryKeyboard,
  NEW_HARNESS_CALLBACK_PREFIX,
  NEW_RETRY_CALLBACK_PREFIX,
} from '../features/tg-ctl/new-command';
import { DEFAULT_MODEL_ID, MODEL_CATALOG, modelsForHarness } from '../features/tg-ctl/models';

describe('parseNewCommand', () => {
  test('name only — model + dir omitted', () => {
    expect(parseNewCommand('/new myproj')).toEqual({ harness: null, model: null, dir: null, name: 'myproj', task: '', dirAfterName: false });
  });

  test('name + task', () => {
    expect(parseNewCommand('/new myproj fix the build')).toEqual({
      harness: null,
      model: null,
      dir: null,
      name: 'myproj',
      task: 'fix the build',
      dirAfterName: false,
    });
  });

  test('model alias + name', () => {
    expect(parseNewCommand('/new opus myproj')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: null,
      name: 'myproj',
      task: '',
      dirAfterName: false,
    });
  });

  test('full id model + abs dir + name + task', () => {
    expect(parseNewCommand('/new claude-sonnet /Users/me/app api do the thing')).toEqual({
      harness: 'claude',
      model: 'claude-sonnet',
      dir: '/Users/me/app',
      name: 'api',
      task: 'do the thing',
      dirAfterName: false,
    });
  });

  test('dir before model (order-tolerant)', () => {
    expect(parseNewCommand('/new /Users/me/app opus api')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: '/Users/me/app',
      name: 'api',
      task: '',
      dirAfterName: false,
    });
  });

  test('no name → empty name (caller shows usage)', () => {
    expect(parseNewCommand('/new').name).toBe('');
    expect(parseNewCommand('/new   ').name).toBe('');
  });

  test('a name that LOOKS like a model is still the name once the slot is taken', () => {
    // `opus` is consumed as the model; the second `opus` token can't be a second model,
    // so it becomes the name.
    expect(parseNewCommand('/new opus opus')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: null,
      name: 'opus',
      task: '',
      dirAfterName: false,
    });
  });

  test('a lone model alias is reclaimed as the NAME (review #1): /new opus names the session opus', () => {
    expect(parseNewCommand('/new opus')).toEqual({ harness: null, model: null, dir: null, name: 'opus', task: '', dirAfterName: false });
    expect(parseNewCommand('/new sonnet')).toEqual({ harness: null, model: null, dir: null, name: 'sonnet', task: '', dirAfterName: false });
  });

  test('a lone harness token is reclaimed as the NAME (symmetry with the lone-model case)', () => {
    // `/new codex` — codex is the only token; consuming it as a harness would leave no name, so it
    // is reclaimed as the name (exercises the empty-`applyConsumed` reclaim path).
    expect(parseNewCommand('/new codex')).toEqual({ harness: null, model: null, dir: null, name: 'codex', task: '', dirAfterName: false });
    expect(parseNewCommand('/new oc')).toEqual({ harness: null, model: null, dir: null, name: 'oc', task: '', dirAfterName: false });
  });

  test('model + lone-dir reclaims the dir as the name, keeping the model', () => {
    // `/new opus /Users/me/app` — model=opus consumed, then /Users/me/app consumed as dir, nothing
    // left for a name → the dir token is reclaimed as the name, model stays.
    expect(parseNewCommand('/new opus /Users/me/app')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: null,
      name: '/Users/me/app',
      task: '',
      dirAfterName: false,
    });
  });

  test('an inline dir after the name is flagged dirAfterName (codex #187)', () => {
    // The parser can't tell `/compact` (a harness command) from `/tmp` (a real
    // dir) — existence is an fs check it must not do. It consumes any `/`-token
    // after the name as the dir but flags dirAfterName so the entrypoint can
    // preserve a REJECTED inline token as task text instead of dropping it.
    expect(parseNewCommand('/new api /compact first')).toEqual({
      harness: null,
      model: null,
      dir: '/compact',
      name: 'api',
      task: 'first',
      dirAfterName: true,
    });
    expect(parseNewCommand('/new api /Users/me/app fix the build')).toEqual({
      harness: null,
      model: null,
      dir: '/Users/me/app',
      name: 'api',
      task: 'fix the build',
      dirAfterName: true,
    });
  });

  test('a dir BEFORE the name is not flagged dirAfterName (codex #187)', () => {
    // A leading path is a dir attempt, never task text — so a rejected leading
    // token is dropped by the entrypoint, not prepended to the task.
    expect(parseNewCommand('/new /Users/me/app api do it')).toEqual({
      harness: null,
      model: null,
      dir: '/Users/me/app',
      name: 'api',
      task: 'do it',
      dirAfterName: false,
    });
  });

  test('extra whitespace is collapsed', () => {
    expect(parseNewCommand('/new   sonnet   myproj   hello   world')).toEqual({
      harness: 'claude',
      model: 'claude-sonnet',
      dir: null,
      name: 'myproj',
      task: 'hello world',
      dirAfterName: false,
    });
  });

  test('tolerates /new@botname', () => {
    expect(parseNewCommand('/new@mybot myproj').name).toBe('myproj');
  });

  test('a non-abs path token is NOT a dir — it becomes the name', () => {
    expect(parseNewCommand('/new relative/path')).toEqual({
      harness: null,
      model: null,
      dir: null,
      name: 'relative/path',
      task: '',
      dirAfterName: false,
    });
  });

  test('harness before name: /new codex task-cli msg keeps codex as harness, not name', () => {
    expect(parseNewCommand('/new codex task-cli msg')).toEqual({
      harness: 'codex',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
      dirAfterName: false,
    });
  });

  test('claude is a harness token, not a default-model alias', () => {
    expect(parseNewCommand('/new claude task-cli msg')).toEqual({
      harness: 'claude',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
      dirAfterName: false,
    });
    expect(parseNewCommand('/new task-cli claude msg')).toEqual({
      harness: 'claude',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
      dirAfterName: false,
    });
  });

  test('harness after name is also accepted', () => {
    expect(parseNewCommand('/new task-cli codex msg')).toEqual({
      harness: 'codex',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
      dirAfterName: false,
    });
  });

  test('opencode harness aliases are accepted before or after the name', () => {
    expect(parseNewCommand('/new oc task-cli msg')).toEqual({
      harness: 'opencode',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
      dirAfterName: false,
    });
    expect(parseNewCommand('/new task-cli opencode msg')).toEqual({
      harness: 'opencode',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'msg',
      dirAfterName: false,
    });
  });

  test('a concrete model token infers its harness', () => {
    expect(parseNewCommand('/new gpt-5.5 task-cli msg')).toEqual({
      harness: 'codex',
      model: 'codex-gpt-5.5',
      dir: null,
      name: 'task-cli',
      task: 'msg',
      dirAfterName: false,
    });
    expect(parseNewCommand('/new task-cli glm-5.2 msg')).toEqual({
      harness: 'opencode',
      model: 'opencode-zai-glm-5.2',
      dir: null,
      name: 'task-cli',
      task: 'msg',
      dirAfterName: false,
    });
  });

  test('soft model aliases after the name stay in the task, not silently consumed', () => {
    expect(parseNewCommand('/new api default behavior is broken')).toEqual({
      harness: null,
      model: null,
      dir: null,
      name: 'api',
      task: 'default behavior is broken',
      dirAfterName: false,
    });
    expect(parseNewCommand('/new api spark joy')).toEqual({
      harness: null,
      model: null,
      dir: null,
      name: 'api',
      task: 'spark joy',
      dirAfterName: false,
    });
  });

  test('an absolute path CONTIGUOUS after the name IS taken as the dir (issue: inline dir arg)', () => {
    // BUG 2: `/new hyperos /Users/ultra/work/foo` must USE the path as the dir and skip the dir
    // prompt — a supplied absolute path is a dir selector in ANY position, not task text. Only the
    // FIRST leftover bareword is the name; the abs path right after it fills the (empty) dir slot.
    expect(parseNewCommand('/new hyperos /Users/ultra/work/foo')).toEqual({
      harness: null,
      model: null,
      dir: '/Users/ultra/work/foo',
      name: 'hyperos',
      task: '',
      dirAfterName: true,
    });
    // The path fills the dir slot; the trailing non-selector word begins the task.
    expect(parseNewCommand('/new api /tmp/do it')).toEqual({
      harness: null,
      model: null,
      dir: '/tmp/do',
      name: 'api',
      task: 'it',
      dirAfterName: true,
    });
  });

  test('BUG 3: /new accepts name, dir, harness, model in ANY order', () => {
    const expected = {
      harness: 'codex' as const,
      model: 'codex-gpt-5.5',
      dir: '/Users/me/app',
      name: 'api',
      task: '',
    };
    // dirAfterName tracks whether the dir token came after the name (see codex #187):
    // true when the path follows the name, false when it precedes it.
    // name → dir → model (model infers codex harness), all after the name.
    expect(parseNewCommand('/new api /Users/me/app gpt-5.5')).toEqual({ ...expected, dirAfterName: true });
    // dir → name → model.
    expect(parseNewCommand('/new /Users/me/app api gpt-5.5')).toEqual({ ...expected, dirAfterName: false });
    // model → name → dir.
    expect(parseNewCommand('/new gpt-5.5 api /Users/me/app')).toEqual({ ...expected, dirAfterName: true });
    // name → model → dir.
    expect(parseNewCommand('/new api gpt-5.5 /Users/me/app')).toEqual({ ...expected, dirAfterName: true });
  });

  test('BUG 3: harness + dir supplied after the name are both consumed, leaving the task', () => {
    expect(parseNewCommand('/new hyperos codex /Users/me/app fix the build')).toEqual({
      harness: 'codex',
      model: null,
      dir: '/Users/me/app',
      name: 'hyperos',
      task: 'fix the build',
      dirAfterName: true,
    });
  });

  test('BUG 3: a run of CONSISTENT post-name selectors is fully consumed, terminating at task text', () => {
    // harness + a consistent concrete model + a dir, all after the name, then real task text — the
    // contiguous consistent selectors are all consumed and `do stuff` begins the task.
    expect(parseNewCommand('/new api codex gpt-5.5 /Users/me/app do stuff')).toEqual({
      harness: 'codex',
      model: 'codex-gpt-5.5',
      dir: '/Users/me/app',
      name: 'api',
      task: 'do stuff',
      dirAfterName: true,
    });
  });

  test('a pre-name harness does not force a mismatched soft model alias to become a model', () => {
    expect(parseNewCommand('/new codex opus')).toEqual({
      harness: 'codex',
      model: null,
      dir: null,
      name: 'opus',
      task: '',
      dirAfterName: false,
    });
  });

  test('a pre-name model wins; a later harness-looking token becomes the name', () => {
    expect(parseNewCommand('/new opus codex')).toEqual({
      harness: 'claude',
      model: 'claude-opus',
      dir: null,
      name: 'codex',
      task: '',
      dirAfterName: false,
    });
  });

  test('post-name selectors are consumed only while contiguous and CONSISTENT; the rest is task text', () => {
    // codex is taken as harness; glm-5.2 is an opencode model — inconsistent with the codex harness,
    // so it is NOT consumed and begins the task tail (a task word that merely looks like a model of
    // the wrong harness stays in the task).
    expect(parseNewCommand('/new task-cli codex glm-5.2 msg')).toEqual({
      harness: 'codex',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'glm-5.2 msg',
      dirAfterName: false,
    });
    expect(parseNewCommand('/new task-cli claude opus msg')).toEqual({
      harness: 'claude',
      model: null,
      dir: null,
      name: 'task-cli',
      task: 'opus msg',
      dirAfterName: false,
    });
  });
});

describe('sessionTargetArgs (tmux new-window session target)', () => {
  test('a NUMERIC session name is targeted as a session, not a window index (index-collision bug)', () => {
    // BUG 1: with a session literally named `1`, a bare `-t 1` is misparsed by tmux as WINDOW
    // INDEX 1 → `create window failed: index 1 in use`. The trailing `:` (and `=` exact match)
    // forces session interpretation; `-a` appends at the next free index.
    expect(sessionTargetArgs('1')).toEqual(['-a', '-t', '=1:']);
  });
  test('an ordinary named session gets the same unambiguous session target', () => {
    expect(sessionTargetArgs('main')).toEqual(['-a', '-t', '=main:']);
  });
  test('no session → no target flag (tmux uses the current/only session)', () => {
    expect(sessionTargetArgs(undefined)).toEqual([]);
    expect(sessionTargetArgs('')).toEqual([]);
  });
});

describe('flat /new retry callback (spawn-failure retry, no re-ask loop)', () => {
  test('parseNewRetryCallback round-trips tnr:<token>', () => {
    expect(parseNewRetryCallback(`${NEW_RETRY_CALLBACK_PREFIX}:abc`)).toEqual({ token: 'abc' });
  });
  test('parseNewRetryCallback rejects malformed / foreign prefixes', () => {
    expect(parseNewRetryCallback('tnr:')).toBeNull();
    expect(parseNewRetryCallback('tnr:abc:extra')).toBeNull();
    expect(parseNewRetryCallback('tnm:abc')).toBeNull();
    expect(parseNewRetryCallback(undefined)).toBeNull();
  });
  test('buildNewRetryKeyboard is a single Retry button carrying the token', () => {
    expect(buildNewRetryKeyboard('tok')).toEqual([
      [{ text: 'Retry spawn', callback_data: 'tnr:tok' }],
    ]);
  });
});

describe('resolveHarnessToken', () => {
  test('harness aliases resolve', () => {
    expect(resolveHarnessToken('codex')).toBe('codex');
    expect(resolveHarnessToken('CLAUDE')).toBe('claude');
    expect(resolveHarnessToken('Codex')).toBe('codex');
    expect(resolveHarnessToken('oc')).toBe('opencode');
    expect(resolveHarnessToken('opencode')).toBe('opencode');
  });

  test('unknown token → null', () => {
    expect(resolveHarnessToken('task-cli')).toBeNull();
  });
});

describe('resolveModelToken', () => {
  test('exact catalog id resolves', () => {
    expect(resolveModelToken(DEFAULT_MODEL_ID)).toBe(DEFAULT_MODEL_ID);
  });
  test('aliases resolve', () => {
    expect(resolveModelToken('opus')).toBe('claude-opus');
    expect(resolveModelToken('OPUS')).toBe('claude-opus');
    expect(resolveModelToken('default')).toBe('claude-default');
    expect(resolveModelToken('gpt-5.5')).toBe('codex-gpt-5.5');
    expect(resolveModelToken('glm-5.2')).toBe('opencode-zai-glm-5.2');
    expect(resolveModelToken('moonshotai/Kimi-K2.7-Code')).toBe('opencode-kimi');
    expect(resolveModelToken('deepseek/deepseek-v4-pro')).toBe('opencode-deepseek');
    expect(resolveModelToken('Qwen/Qwen3.7-Max')).toBe('opencode-qwen');
  });
  test('unknown token → null', () => {
    expect(resolveModelToken('claude')).toBeNull();
    expect(resolveModelToken('gpt-9')).toBeNull();
    expect(resolveModelToken('myproj')).toBeNull();
  });
});

describe('parentDirs', () => {
  test('lists ancestors nearest-first, stopping above root', () => {
    expect(parentDirs('/a/b/c')).toEqual(['/a/b', '/a']);
  });
  test('trailing slash is ignored', () => {
    expect(parentDirs('/a/b/c/')).toEqual(['/a/b', '/a']);
  });
  test('one-level path has no listed parent (would be root)', () => {
    expect(parentDirs('/a')).toEqual([]);
  });
  test('root itself has none', () => {
    expect(parentDirs('/')).toEqual([]);
  });
});

describe('rankNewDirChoices', () => {
  const allDirs = (_p: string): boolean => true;

  test('adds parents and keeps a child ahead of its parent', () => {
    expect(rankNewDirChoices(['/Users/me/app'], allDirs)).toEqual([
      '/Users/me/app',
      '/Users/me',
      '/Users',
    ]);
  });

  test('LRU/MRU: newer cwd outranks older, dedup keeps first (newest) mention', () => {
    // app is newest, lib is older; both share /Users/me. The shared parent keeps the rank of
    // its FIRST (newest) appearance — right after app, before lib.
    expect(rankNewDirChoices(['/Users/me/app', '/Users/me/lib'], allDirs)).toEqual([
      '/Users/me/app',
      '/Users/me',
      '/Users',
      '/Users/me/lib',
    ]);
  });

  test('non-existing dirs are filtered out', () => {
    const onlyApp = (p: string): boolean => p === '/Users/me/app';
    expect(rankNewDirChoices(['/Users/me/app'], onlyApp)).toEqual(['/Users/me/app']);
  });

  test('relative / empty / undefined candidates are skipped', () => {
    expect(rankNewDirChoices(['relative', '', undefined, '/abs/x'], allDirs)).toEqual([
      '/abs/x',
      '/abs',
    ]);
  });

  test('capped at MAX_NEW_DIR_CHOICES', () => {
    const many = Array.from({ length: 20 }, (_v, i) => `/d${i}/deep/nested`);
    const out = rankNewDirChoices(many, allDirs);
    expect(out.length).toBe(MAX_NEW_DIR_CHOICES);
  });

  test('a single deep cwd expands at most MAX_PARENTS_PER_CWD parents (review #4: no menu starvation)', () => {
    // /a/b/c/d/e/f → the cwd + only its 2 nearest parents (/a/b/c/d/e, /a/b/c/d), not the whole chain.
    expect(rankNewDirChoices(['/a/b/c/d/e/f'], allDirs)).toEqual(['/a/b/c/d/e/f', '/a/b/c/d/e', '/a/b/c/d']);
  });

  test('a deep cwd does NOT crowd a sibling project out of the menu (review #4)', () => {
    // With the parent cap, the second project still appears even after a deep first one.
    const out = rankNewDirChoices(['/a/b/c/d/e/f', '/proj/two'], allDirs);
    expect(out).toContain('/proj/two');
  });
});

describe('nameCollides', () => {
  test('true when the slug matches a live window name', () => {
    expect(nameCollides('myproj', ['rig', 'myproj', '3d'])).toBe(true);
  });
  test('false when no match', () => {
    expect(nameCollides('myproj', ['rig', '3d'])).toBe(false);
  });
});

describe('flat /new callbacks', () => {
  test('parseNewHarnessCallback round-trips', () => {
    expect(parseNewHarnessCallback(`${NEW_HARNESS_CALLBACK_PREFIX}:abc:codex`)).toEqual({
      token: 'abc',
      harness: 'codex',
    });
  });
  test('parseNewHarnessCallback rejects malformed', () => {
    expect(parseNewHarnessCallback('tnh:abc')).toBeNull();
    expect(parseNewHarnessCallback('tnh:abc:nope')).toBeNull();
    expect(parseNewHarnessCallback('tgm:abc:codex')).toBeNull();
    expect(parseNewHarnessCallback(undefined)).toBeNull();
  });
  test('parseNewModelCallback round-trips', () => {
    expect(parseNewModelCallback(`${NEW_MODEL_CALLBACK_PREFIX}:abc:claude-opus`)).toEqual({
      token: 'abc',
      modelId: 'claude-opus',
    });
  });
  test('parseNewModelCallback rejects malformed', () => {
    expect(parseNewModelCallback('tnm:abc')).toBeNull();
    expect(parseNewModelCallback('tgm:abc:claude-opus')).toBeNull(); // topic prefix, not ours
    expect(parseNewModelCallback(undefined)).toBeNull();
  });
  test('parseNewDirCallback round-trips', () => {
    expect(parseNewDirCallback(`${NEW_DIR_CALLBACK_PREFIX}:abc:0`)).toEqual({ token: 'abc', index: 0 });
    expect(parseNewDirCallback(`${NEW_DIR_CALLBACK_PREFIX}:abc:3`)).toEqual({ token: 'abc', index: 3 });
  });
  test('parseNewDirCallback rejects a leading-zero / non-numeric index', () => {
    expect(parseNewDirCallback('tnp:abc:01')).toBeNull();
    expect(parseNewDirCallback('tnp:abc:x')).toBeNull();
    expect(parseNewDirCallback('tnp:abc:-1')).toBeNull();
  });
  test('parseNewPrivateTopicFallbackCallback round-trips continue/cancel choices', () => {
    expect(parseNewPrivateTopicFallbackCallback(`${NEW_PRIVATE_TOPIC_FALLBACK_CALLBACK_PREFIX}:abc:${NEW_PRIVATE_TOPIC_FALLBACK_CONTINUE}`)).toEqual({
      token: 'abc',
      choice: NEW_PRIVATE_TOPIC_FALLBACK_CONTINUE,
    });
    expect(parseNewPrivateTopicFallbackCallback(`${NEW_PRIVATE_TOPIC_FALLBACK_CALLBACK_PREFIX}:abc:${NEW_PRIVATE_TOPIC_FALLBACK_CANCEL}`)).toEqual({
      token: 'abc',
      choice: NEW_PRIVATE_TOPIC_FALLBACK_CANCEL,
    });
  });
  test('parseNewPrivateTopicFallbackCallback rejects malformed choices', () => {
    expect(parseNewPrivateTopicFallbackCallback('tnf:abc')).toBeNull();
    expect(parseNewPrivateTopicFallbackCallback('tnf:abc:later')).toBeNull();
    expect(parseNewPrivateTopicFallbackCallback('tnm:abc:continue')).toBeNull();
    expect(parseNewPrivateTopicFallbackCallback(undefined)).toBeNull();
  });
});

describe('keyboards', () => {
  test('harness keyboard has one button per supported harness with the tnh: callback', () => {
    const kb = buildNewHarnessKeyboard('tok');
    expect(kb.map((row) => row[0].callback_data)).toEqual([
      `${NEW_HARNESS_CALLBACK_PREFIX}:tok:claude`,
      `${NEW_HARNESS_CALLBACK_PREFIX}:tok:codex`,
      `${NEW_HARNESS_CALLBACK_PREFIX}:tok:opencode`,
    ]);
  });
  test('model keyboard has one button per catalog model with the tnm: callback', () => {
    const kb = buildNewModelKeyboard('tok');
    expect(kb.length).toBe(MODEL_CATALOG.length);
    expect(kb[0][0].callback_data).toBe(`${NEW_MODEL_CALLBACK_PREFIX}:tok:${MODEL_CATALOG[0].id}`);
    expect(kb[0][0].text).toBe(MODEL_CATALOG[0].label);
  });
  test('model keyboard can be filtered to a harness', () => {
    const kb = buildNewModelKeyboard('tok', modelsForHarness('codex'));
    expect(kb.length).toBeGreaterThan(0);
    expect(kb.every((row) => row[0].callback_data.includes(':codex-'))).toBe(true);
  });
  test('dir keyboard has one button per choice with the tnp:<token>:<index> callback', () => {
    const kb = buildNewDirKeyboard('tok', ['/a', '/b']);
    expect(kb).toEqual([
      [{ text: '/a', callback_data: 'tnp:tok:0' }],
      [{ text: '/b', callback_data: 'tnp:tok:1' }],
    ]);
  });
  test('dir keyboard is empty for no choices', () => {
    expect(buildNewDirKeyboard('tok', [])).toEqual([]);
  });
  test('private-topic fallback keyboard offers continue and cancel callbacks', () => {
    expect(buildNewPrivateTopicFallbackKeyboard('tok')).toEqual([
      [{ text: 'Continue without topics', callback_data: 'tnf:tok:continue' }],
      [{ text: 'Cancel this spawn', callback_data: 'tnf:tok:cancel' }],
    ]);
  });
});
