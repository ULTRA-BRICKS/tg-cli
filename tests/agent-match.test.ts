import { expect, test } from 'bun:test';
import {
  parseAgentCommand,
  phoneticKey,
  matchWindows,
  groupBySession,
  buildAgentCancelKeyboard,
  buildAgentSelectMessage,
  parseAgentCallback,
  parseAgentCancelCallback,
  distinctLabels,
  dedupeCandidates,
  suggestSelector,
  type AgentCandidate,
} from '../features/tg-ctl/agent-match';

const cand = (
  paneId: string,
  sessionName: string,
  windowIndex: number,
  windowName: string,
  agent: AgentCandidate['agent'] = 'claude',
  panePath?: string,
): AgentCandidate => ({ paneId, sessionName, windowIndex, windowName, agent, panePath });

// --- parseAgentCommand ---

test('parse: selector + message', () => {
  expect(parseAgentCommand('/agent feat-bot deploy now')).toEqual({
    selector: 'feat-bot',
    rest: 'deploy now',
    all: 'feat-bot deploy now',
  });
});

test('parse: bare /agent → no selector', () => {
  expect(parseAgentCommand('/agent')).toEqual({ selector: null, rest: '', all: '' });
  expect(parseAgentCommand('/agent   ')).toEqual({ selector: null, rest: '', all: '' });
});

test('parse: single token → selector with empty rest', () => {
  expect(parseAgentCommand('/agent apibot')).toEqual({ selector: 'apibot', rest: '', all: 'apibot' });
});

test('parse: tolerates /agent@botname and multiline', () => {
  expect(parseAgentCommand('/agent@mybot api\nline two')).toEqual({
    selector: 'api',
    rest: 'line two',
    all: 'api\nline two',
  });
});

// --- phoneticKey ---

test('phonetic: Cyrillic transliterates to the same key as Latin', () => {
  expect(phoneticKey('апи')).toBe('api');
  expect(phoneticKey('Codex')).toBe(phoneticKey('кодекс')); // both → kodeks
});

test('phonetic: folds separators, doubles, and sound-equivalents', () => {
  expect(phoneticKey('api-bot')).toBe('apibot');
  expect(phoneticKey('ph')).toBe('f');
  expect(phoneticKey('mood')).toBe('mod'); // doubled o collapses
  expect(phoneticKey('claude')).toBe('klaude'); // hard c → k
});

// --- matchWindows ---

const fleet = [
  cand('%1', 'work', 0, 'api-bot', 'claude'),
  cand('%2', 'work', 1, 'feat-autolink', 'codex'),
  cand('%3', 'side', 0, 'claude-main', 'claude'),
];

test('match: exact-ish phonetic selector is confident', () => {
  const r = matchWindows('apibot', fleet);
  expect(r.confident).toBe(true);
  expect(r.matches[0].paneId).toBe('%1');
});

test('match: Cyrillic selector matches Latin window', () => {
  const r = matchWindows('апибот', fleet);
  expect(r.confident).toBe(true);
  expect(r.matches[0].windowName).toBe('api-bot');
});

test('match: ambiguous prefix returns several, not confident', () => {
  const two = [cand('%1', 's', 0, 'feat-a'), cand('%2', 's', 1, 'feat-b')];
  const r = matchWindows('feat', two);
  expect(r.confident).toBe(false);
  expect(r.matches.length).toBe(2);
});

test('match: gibberish selector matches nothing', () => {
  expect(matchWindows('zzzqqq', fleet).matches).toEqual([]);
});

test('match: a cwd-derived selector routes when window names are bare/numeric', () => {
  // The bug shape: three claude panes, window name "4" for all, distinct cwds.
  // The picker hands back the cwd project ("3d-cli") — matchWindows MUST resolve
  // it to that pane via the cwd, since the window name "4" never matches "3d-cli".
  const dup = [
    cand('%1', '4', 0, '4', 'claude', '/Users/u/xp/rig'),
    cand('%2', '4', 0, '4', 'claude', '/Users/u/xp/3d-cli'),
    cand('%3', '4', 0, '4', 'claude', '/Users/u/work/hyperide'),
  ];
  const r = matchWindows('3d-cli', dup);
  expect(r.confident).toBe(true);
  expect(r.matches[0].paneId).toBe('%2');
});

test('match: window name still wins when it carries signal (cwd is additive)', () => {
  const r = matchWindows('apibot', fleet); // fleet has no panePath set
  expect(r.confident).toBe(true);
  expect(r.matches[0].paneId).toBe('%1');
});

// REGRESSION GUARD: cwd-matching must NOT change legacy routing for a pane with a
// MEANINGFUL window name. Pane W is named "deploy"; pane X merely sits in a
// `…/deploy` cwd but has its own real name "staging". `/agent deploy` must still
// route CONFIDENTLY to W and never tie with X on the cwd — cwd is consulted only
// for bare/numeric window names.
test('match: a real window name is NOT tied by another pane sharing that cwd', () => {
  const two = [
    cand('%W', 's', 0, 'deploy', 'claude', '/x/misc'),
    cand('%X', 's', 1, 'staging', 'claude', '/x/deploy'),
  ];
  const r = matchWindows('deploy', two);
  expect(r.confident).toBe(true);
  expect(r.matches[0].paneId).toBe('%W');
});

// The window-name tier wins FIRST: a real `deploy` window routes directly even
// when a BARE-named sibling sits in a `…/deploy` cwd (which would tie if cwd were
// always consulted). cwd is only consulted when the name tier finds nothing.
test('match: a real window name beats a bare sibling sitting in that cwd', () => {
  const two = [
    cand('%W', 's', 0, 'deploy', 'claude', '/x/misc'),
    cand('%B', 's', 1, '4', 'claude', '/x/deploy'), // bare window, cwd basename "deploy"
  ];
  const r = matchWindows('deploy', two);
  expect(r.confident).toBe(true);
  expect(r.matches[0].paneId).toBe('%W');
});

// tmux's DEFAULT auto-rename gives several claude panes the SAME meaningful window
// name ("node"/"claude") — not bare, but useless for singling one out. The name
// tier ties (not confident) → no match → the cwd tier kicks in and the project
// dir routes confidently. This is the common real-world shape, not just numeric.
test('match: auto-renamed identical window names disambiguate by cwd', () => {
  const renamed = [
    cand('%1', 's', 0, 'node', 'claude', '/Users/u/xp/rig'),
    cand('%2', 's', 1, 'node', 'claude', '/Users/u/xp/3d-cli'),
  ];
  const r = matchWindows('3d-cli', renamed);
  expect(r.confident).toBe(true);
  expect(r.matches[0].paneId).toBe('%2');
  // and the suggested selector round-trips for each
  for (const target of renamed) {
    const sel = suggestSelector(target, renamed);
    const m = matchWindows(sel, renamed);
    expect(m.confident && m.matches[0].paneId === target.paneId).toBe(true);
  }
});

// ANTI-TYPO GUARD: the cwd tier is STRICT (exact/prefix only). A typo in a window
// name that merely RESONATES phonetically (edit-distance / substring) with some
// other pane's cwd must NOT become a confident auto-route — it stays a no-match so
// the picker shows. Here selector "ri" is a prefix of cwd "rig" (intentional, that
// routes), but a fuzzy near-miss like "rigx" against cwd "rig" must NOT confidently
// land via the loose edit-distance band.
test('match: cwd tier is EXACT-only — neither fuzzy nor prefix silently routes', () => {
  const fleet2 = [
    cand('%1', 's', 0, 'node', 'claude', '/x/rig'),
    cand('%2', 's', 1, 'node', 'claude', '/x/other'),
  ];
  // exact cwd basename hit is honoured (this is what the picker hands back)
  expect(matchWindows('rig', fleet2).matches[0]?.paneId).toBe('%1');
  // a fuzzy near-miss ("rag" ~ "rig") must not route
  expect(matchWindows('rag', fleet2).matches).toEqual([]);
  // a PREFIX of a cwd basename must NOT route either — a short typed token like
  // "dev" must never resonate into a "…/development" project via the cwd tier.
  const dev = [
    cand('%A', 's', 0, 'node', 'claude', '/x/development'),
    cand('%B', 's', 1, 'node', 'claude', '/x/server'),
  ];
  expect(matchWindows('dev', dev).matches).toEqual([]);
  // the full basename still routes exactly
  expect(matchWindows('development', dev).matches[0]?.paneId).toBe('%A');
});

// FINDING (review): an ambiguous `/agent <sel>` with no message narrows the
// picker to a SUBSET, but the user's follow-up command re-resolves against the
// FULL fleet — so the daemon now verifies suggestSelector against the full live
// snapshot. This asserts the underlying property: given the full fleet,
// suggestSelector never returns a token that confidently routes to a DIFFERENT
// pane than the chosen one (the guarantee the daemon now relies on).
test('suggest: against the full fleet, the returned token never routes to another pane', () => {
  // %2 has a bare window but a cwd basename "rig" identical to %1's cwd — the
  // naive cwd suggestion "rig" would confidently land on %2, not the target %1.
  const full = [
    cand('%1', 's', 0, 'rig', 'claude', '/x/rig'), // target (real name "rig")
    cand('%2', 's', 1, '4', 'claude', '/x/rig'), // bare window, same cwd basename
  ];
  for (const target of full) {
    const sel = suggestSelector(target, full);
    const m = matchWindows(sel, full);
    expect(m.confident && m.matches[0].paneId !== target.paneId).toBe(false);
  }
});

// --- groupBySession ---

test('group: sessions in first-appearance order, panes by window index', () => {
  const groups = groupBySession([
    cand('%2', 'work', 1, 'b'),
    cand('%3', 'side', 0, 'c'),
    cand('%1', 'work', 0, 'a'),
  ]);
  expect(groups.map((g) => g.session)).toEqual(['work', 'side']);
  expect(groups[0].candidates.map((c) => c.paneId)).toEqual(['%1', '%2']);
});

test('group: preserveOrder keeps the given (LRU/MRU) order within a session', () => {
  // reply picker passes candidates already in LRU/MRU order — a windowIndex
  // re-sort would discard the most-recent-first ranking (codex review P2).
  const groups = groupBySession([cand('%2', 'work', 5, 'recent'), cand('%1', 'work', 0, 'old')], true);
  expect(groups[0].candidates.map((c) => c.paneId)).toEqual(['%2', '%1']);
});

// --- buttons round-trip ---

test('buttons: one per candidate, callback round-trips to the right pane', () => {
  const msg = buildAgentSelectMessage(42, fleet, 'tok1', 'deploy the thing');
  const flat = msg.reply_markup.inline_keyboard.flat();
  expect(flat.length).toBe(3);
  const parsed = parseAgentCallback(flat[2].callback_data);
  expect(parsed).toEqual({ token: 'tok1', index: 2 });
  expect(fleet[parsed!.index].paneId).toBe('%3');
  // The route-picker prompt keeps the message preview, but the text body must NOT
  // duplicate the buttons: no `▸ <session>` group header, no per-agent label lines.
  expect(msg.text).toContain('deploy the thing');
  expect(msg.text).not.toContain('▸');
});

// --- buttons-only: the text body never duplicates the buttons (#63) ---

// The CTO complaint: the picker rendered a `▸ <window>` group header AND a
// per-agent text list ON TOP of the inline-keyboard buttons. The text must be a
// minimal prompt only; the distinct labels live exclusively on the buttons.
test('buttons-only: no ▸ group header and no per-agent label line in the text', () => {
  const dup = [
    cand('%1', '4', 0, '4', 'claude', '/Users/u/xp/rig'),
    cand('%2', '4', 0, '4', 'claude', '/Users/u/xp/3d-cli'),
    cand('%3', '4', 0, '4', 'claude', '/Users/u/work/hyperide'),
  ];
  const labels = distinctLabels(dup);
  const bare = buildAgentSelectMessage(7, dup, 'tok', ''); // bare /agent picker
  // exactly the minimal prompt — nothing more
  expect(bare.text).toBe('Pick an agent:');
  expect(bare.text).not.toContain('▸');
  // the distinct labels appear ONLY on the buttons, never duplicated in the text
  for (const label of labels) expect(bare.text).not.toContain(label);
  expect(bare.reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual(labels);

  // the reply/route picker (non-empty preview) is equally buttons-only
  const route = buildAgentSelectMessage(7, dup, 'tok', 'ship it');
  expect(route.text).not.toContain('▸');
  for (const label of labels) expect(route.text).not.toContain(label);
  expect(route.reply_markup.inline_keyboard.flat().map((b) => b.text)).toEqual(labels);
});

test('parseAgentCallback: rejects malformed data', () => {
  expect(parseAgentCallback('tgq:tok:0')).toBeNull();
  expect(parseAgentCallback('tga:tok')).toBeNull();
  expect(parseAgentCallback('tga::1')).toBeNull();
  expect(parseAgentCallback(undefined)).toBeNull();
});

test('cancel button: builds and parses the bare-/agent cancel callback', () => {
  expect(buildAgentCancelKeyboard('tok9', 'Cancel')).toEqual({
    inline_keyboard: [[{ text: 'Cancel', callback_data: 'tgc:tok9' }]],
  });
  expect(parseAgentCancelCallback('tgc:tok9')).toEqual({ token: 'tok9' });
  expect(parseAgentCancelCallback('tgc:')).toBeNull();
  expect(parseAgentCancelCallback('tga:tok9:0')).toBeNull();
});

// --- distinct labels (THE BUG: three "4 · claude" rows) ---

// The exact reported symptom: window "4", three claude panes, no window names →
// the candidate builder falls back to the session name "4" for all three. The
// OLD label `<window> · <agent>` = "4 · claude" ×3, indistinguishable. The cwd
// basename (project dir) makes each one distinct.
test('labels: bare numeric window names disambiguate by cwd project dir', () => {
  const dup = [
    cand('%1', '4', 0, '4', 'claude', '/Users/u/xp/rig'),
    cand('%2', '4', 0, '4', 'claude', '/Users/u/xp/3d-cli'),
    cand('%3', '4', 0, '4', 'claude', '/Users/u/work/hyperide'),
  ];
  const labels = distinctLabels(dup);
  expect(labels).toEqual(['rig · claude', '3d-cli · claude', 'hyperide · claude']);
  // every label is distinct — the actual fix
  expect(new Set(labels).size).toBe(3);
});

test('labels: a real window name is kept; cwd is only the fallback', () => {
  const mixed = [
    cand('%1', 'work', 0, 'api-bot', 'claude', '/Users/u/api'),
    cand('%2', 'work', 1, 'feat-x', 'codex', '/Users/u/feat'),
  ];
  expect(distinctLabels(mixed)).toEqual(['api-bot · claude', 'feat-x · codex']);
});

test('labels: identical window names (non-bare) collide → append project', () => {
  const same = [
    cand('%1', 's', 0, 'dev', 'claude', '/Users/u/repo-a'),
    cand('%2', 's', 1, 'dev', 'claude', '/Users/u/repo-b'),
  ];
  expect(distinctLabels(same)).toEqual(['dev · claude · repo-a', 'dev · claude · repo-b']);
});

test('labels: same window + agent + cwd → pane id is the last-resort distinguisher', () => {
  const trulySame = [
    cand('%1', 's', 0, 'dev', 'claude', '/Users/u/repo'),
    cand('%2', 's', 1, 'dev', 'claude', '/Users/u/repo'),
  ];
  const labels = distinctLabels(trulySame);
  expect(new Set(labels).size).toBe(2);
  expect(labels[0]).toContain('%1');
  expect(labels[1]).toContain('%2');
});

// An empty window name AND no cwd must not render a dangling "· claude" — the
// label degrades to the agent alone (rare: the builder usually fills a name).
test('labels: empty window name + no cwd → no leading separator', () => {
  const c = [cand('%1', '', 0, '', 'claude', undefined)];
  expect(distinctLabels(c)).toEqual(['claude']);
});

// --- tg-cli#75 fix C: user-set WINDOW NAMES beat the cwd basename ---

// The CTO's exact setup: three claude panes in numeric window "4", but each with
// a DISTINCT user-set window name (rig / 3d / ext). The label must read the WINDOW
// NAME, NOT the cwd basename — `ext` proves it: its cwd basename is "hyperide", so
// a cwd-derived label would wrongly say "hyperide".
test('labels: distinct user-set window names are used verbatim, NOT the cwd basenames', () => {
  const fleet = [
    cand('%1', '4', 0, 'rig', 'claude', '/Users/u/xp/agent-tools'),
    cand('%2', '4', 1, '3d', 'claude', '/Users/u/xp/3d-cli'),
    cand('%3', '4', 2, 'ext', 'claude', '/Users/u/work/hyperide'),
  ];
  expect(distinctLabels(fleet)).toEqual(['rig · claude', '3d · claude', 'ext · claude']);
});

// tmux `automatic-rename` ON sets the window name to the running command — a shell
// (zsh/node) or the cc VERSION string ("2.1.181"). None is a user label, so each
// is treated as BARE and the label falls back to the cwd project dir.
test('labels: a shell-command auto-rename default (node) falls back to the cwd', () => {
  const fleet = [
    cand('%1', '4', 0, 'node', 'claude', '/Users/u/xp/rig'),
    cand('%2', '4', 1, 'node', 'claude', '/Users/u/xp/3d-cli'),
  ];
  expect(distinctLabels(fleet)).toEqual(['rig · claude', '3d-cli · claude']);
});

test('labels: a bare version-string window name (cc command) falls back to the cwd', () => {
  const fleet = [
    cand('%1', '4', 0, '2.1.181', 'claude', '/Users/u/work/hyperide'),
    cand('%2', '4', 1, '2.1.185', 'claude', '/Users/u/xp/3d-cli'),
  ];
  expect(distinctLabels(fleet)).toEqual(['hyperide · claude', '3d-cli · claude']);
});

test('labels: a single zsh default falls back to its project dir, not "zsh · claude"', () => {
  const fleet = [cand('%1', 'main', 0, 'zsh', 'claude', '/Users/u/work/svc')];
  expect(distinctLabels(fleet)).toEqual(['svc · claude']);
});

// --- dedupe ---

test('dedupe: drops a pane id listed twice, keeps first-seen order', () => {
  const withDup = [
    cand('%1', 's', 0, 'a'),
    cand('%2', 's', 1, 'b'),
    cand('%1', 's', 0, 'a'), // a merged/flaky snapshot repeated %1
  ];
  expect(dedupeCandidates(withDup).map((c) => c.paneId)).toEqual(['%1', '%2']);
});

// --- bare-/agent picker: buttons, not text ---

test('buttons: bare /agent (no message) is a PICKER with distinct labelled buttons', () => {
  const dup = [
    cand('%1', '4', 0, '4', 'claude', '/Users/u/xp/rig'),
    cand('%2', '4', 0, '4', 'claude', '/Users/u/xp/3d-cli'),
  ];
  const msg = buildAgentSelectMessage(7, dup, 'tok', ''); // empty message = bare /agent
  const flat = msg.reply_markup.inline_keyboard.flat();
  expect(flat.map((b) => b.text)).toEqual(['rig · claude', '3d-cli · claude']);
  // each button routes to its own pane via the index
  expect(parseAgentCallback(flat[0].callback_data)).toEqual({ token: 'tok', index: 0 });
  expect(parseAgentCallback(flat[1].callback_data)).toEqual({ token: 'tok', index: 1 });
  // pick-an-agent header (no message preview), NOT the "Route to which agent?" wording
  expect(msg.text).toContain('Pick an agent');
});

// --- suggestSelector ---

test('suggest: a unique non-bare window name is the selector', () => {
  const c = [cand('%1', 's', 0, 'api-bot', 'claude', '/x/api')];
  expect(suggestSelector(c[0], c)).toBe('api-bot');
});

test('suggest: a bare numeric window name → the cwd project dir', () => {
  const c = [
    cand('%1', '4', 0, '4', 'claude', '/Users/u/xp/rig'),
    cand('%2', '4', 0, '4', 'claude', '/Users/u/xp/3d-cli'),
  ];
  expect(suggestSelector(c[1], c)).toBe('3d-cli');
});

// The finding-#1 guarantee: whatever suggestSelector returns MUST route back to
// the chosen pane via matchWindows (else the handed-out command is a dead end /
// misroute). Verify the round-trip for every candidate in the bug shape.
test('suggest: the returned selector confidently routes to its own pane', () => {
  const fleet3 = [
    cand('%1', '4', 0, '4', 'claude', '/Users/u/xp/rig'),
    cand('%2', '4', 0, '4', 'claude', '/Users/u/xp/3d-cli'),
    cand('%3', '4', 0, '4', 'claude', '/Users/u/work/hyperide'),
  ];
  for (const target of fleet3) {
    const sel = suggestSelector(target, fleet3);
    const m = matchWindows(sel, fleet3);
    expect(m.confident).toBe(true);
    expect(m.matches[0].paneId).toBe(target.paneId);
  }
});

// A selector is the FIRST whitespace token of the command, so a cwd basename with
// a space (e.g. "my project") can't be the selector verbatim — it must never be
// returned (its first word would tokenize off and the rest leak into the message).
test('suggest: a cwd basename containing a space is never returned as the selector', () => {
  const c = [cand('%1', '4', 0, '4', 'claude', '/Users/u/my project')];
  const sel = suggestSelector(c[0], c);
  expect(/\s/.test(sel)).toBe(false);
});

// MISROUTE GUARD (review finding): the suggested selector must NEVER confidently
// route to a DIFFERENT pane. Target has a MEANINGFUL but non-unique window name
// ("dev", tied with a sibling) and cwd `/x/rig`; a THIRD pane sits in a BARE
// window "4" whose cwd basename is also "rig". The naive fallback would hand back
// "rig" — which confidently routes to the bare-window pane, not the target. The
// guard must instead degrade to a non-misrouting suggestion.
test('suggest: never returns a token that confidently routes to another pane', () => {
  const tricky = [
    cand('%T', 's1', 0, 'dev', 'claude', '/x/rig'), // target
    cand('%O1', 's1', 1, 'dev', 'claude', '/x/foo'), // ties on the window name "dev"
    cand('%O2', 's2', 0, '4', 'claude', '/x/rig'), // bare window, cwd basename "rig"
  ];
  const target = tricky[0];
  const sel = suggestSelector(target, tricky);
  const m = matchWindows(sel, tricky);
  // the suggested selector must NOT confidently land on a non-target pane
  expect(m.confident && m.matches[0].paneId !== target.paneId).toBe(false);
});

// distinctLabels leading-project guard: two candidates in DIFFERENT sessions, both
// with a bare window name AND the same cwd basename ("rig"). The project pass
// can't disambiguate (the label already leads with "rig"), so the pane-id pass
// must — the final labels stay distinct.
test('labels: two bare-window panes with the same cwd basename stay distinct (pane-id pass)', () => {
  const same = [
    cand('%1', '0', 0, '0', 'claude', '/x/rig'), // bare numeric window, cwd basename "rig"
    cand('%2', '1', 0, '1', 'claude', '/y/rig'), // bare numeric window, same basename "rig"
  ];
  const labels = distinctLabels(same);
  // both base labels lead with the project "rig" → "rig · claude"; the project
  // pass can't help (already leads with it), so the pane-id pass disambiguates.
  expect(new Set(labels).size).toBe(2);
  expect(labels[0]).toContain('%1');
  expect(labels[1]).toContain('%2');
});
