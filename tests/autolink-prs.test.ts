import { expect, test } from 'bun:test';
import { detectRefs, findRefMatches } from '../features/autolink-prs/detect';
import { parseIssueResponse, probeRefsInRepo, type ForgeRef } from '../features/autolink-prs/resolve';
import type { ForgejoGet, ForgejoRepo, HttpResult } from '../features/forgejo/client';
import { CACHE_TTL_MS, cacheKey, mergeIntoCache, splitByCache } from '../features/autolink-prs/cache';
import { buildEntries, linkifyRefs, prStateSuffix, refAnchor } from '../features/autolink-prs/render';
import { applyAutolink, type TicketInfo } from '../features/autolink-tasks/render';
import { parseHintState, serializeHintState, markHint } from '../features/autolink-tasks/state';

// --- Detection ---

test('detect: a bare ref is found', () => {
  expect(detectRefs('fixes #260 today')).toEqual([260]);
});

test('detect: multiple refs, dedup by number, first-appearance order', () => {
  expect(detectRefs('#1 then #22, #1 again')).toEqual([1, 22]);
});

test('detect: punctuation around the ref is fine', () => {
  expect(detectRefs('(#260), see #261. and #262,')).toEqual([260, 261, 262]);
});

test('detect: a leading alphanumeric disqualifies', () => {
  expect(detectRefs('x#1 and abc#42')).toEqual([]);
});

test('detect: a trailing alphanumeric disqualifies', () => {
  expect(detectRefs('#1a #42x')).toEqual([]);
});

test('detect: #0 is not a ref (must be [1-9]\\d*)', () => {
  expect(detectRefs('#0 and #00')).toEqual([]);
});

test('detect: refs inside URLs are skipped', () => {
  expect(detectRefs('see https://git.hyperide.ai/o/r/pulls/260 for details')).toEqual([]);
});

test('detect: URL mention does not shadow a separate plain mention', () => {
  expect(detectRefs('#260 (https://git.hyperide.ai/o/r/pulls/260)')).toEqual([260]);
});

test('detect: a bare # or #word is not a ref', () => {
  expect(detectRefs('# heading and #feature-branch')).toEqual([]);
});

test('detect: multiline text', () => {
  expect(detectRefs('line one #9\nline two #10')).toEqual([9, 10]);
});

test('detect: empty and ref-free text', () => {
  expect(detectRefs('')).toEqual([]);
  expect(detectRefs('no refs here, just 3-2 numbers')).toEqual([]);
});

test('findRefMatches: returns start/end/number triples', () => {
  expect(findRefMatches('(#260)')).toEqual([{ start: 1, end: 5, number: 260 }]);
});

// --- Forgejo REST response parsing + probes ---

const FORGE: ForgejoRepo = { origin: 'https://git.hyperide.ai', hostKey: 'git.hyperide.ai', owner: 'ultrabricks', name: 'tg-cli' };

// Shapes as GET /api/v1/repos/{o}/{r}/issues/{n} returns them (fields tg reads).
const apiPr = (n: number, opts: { merged?: boolean; draft?: boolean; state?: string } = {}) =>
  JSON.stringify({
    number: n,
    title: `PR ${n}`,
    state: opts.state ?? (opts.merged ? 'closed' : 'open'),
    html_url: `https://git.hyperide.ai/ultrabricks/tg-cli/pulls/${n}`,
    pull_request: { merged: opts.merged ?? false, merged_at: null, draft: opts.draft ?? false, html_url: `https://git.hyperide.ai/ultrabricks/tg-cli/pulls/${n}` },
  });
const apiIssue = (n: number, state = 'open') =>
  JSON.stringify({ number: n, title: `Issue ${n}`, state, html_url: `https://git.hyperide.ai/ultrabricks/tg-cli/issues/${n}`, pull_request: null });

const ok = (body: string): HttpResult => ({ status: 200, body });

test('parse issue JSON: a merged PR keeps its html_url and reads as MERGED', () => {
  expect(parseIssueResponse(apiPr(260, { merged: true }), 260)).toEqual({
    number: 260,
    kind: 'pr',
    title: 'PR 260',
    url: 'https://git.hyperide.ai/ultrabricks/tg-cli/pulls/260',
    state: 'MERGED',
    isDraft: false,
  });
});

test('parse issue JSON: an issue (pull_request null) is kind issue with its own URL', () => {
  const ref = parseIssueResponse(apiIssue(42), 42);
  expect(ref?.kind).toBe('issue');
  expect(ref?.url).toBe('https://git.hyperide.ai/ultrabricks/tg-cli/issues/42');
  expect(ref?.state).toBe('OPEN');
  expect(ref).not.toHaveProperty('isDraft');
});

test('parse issue JSON: draft and closed-unmerged PR states', () => {
  expect(parseIssueResponse(apiPr(7, { draft: true }), 7)).toMatchObject({ kind: 'pr', state: 'OPEN', isDraft: true });
  expect(parseIssueResponse(apiPr(8, { state: 'closed' }), 8)).toMatchObject({ kind: 'pr', state: 'CLOSED' });
});

test('parse issue JSON: wrong number, malformed JSON or a non-http URL is rejected', () => {
  expect(parseIssueResponse(apiIssue(9), 8)).toBeNull();
  expect(parseIssueResponse('garbage', 8)).toBeNull();
  expect(parseIssueResponse(JSON.stringify({ number: 8, title: 'x', html_url: 'javascript:alert(1)' }), 8)).toBeNull();
});

test('probeRefsInRepo: empty numbers → ok empty, no request', async () => {
  let called = false;
  const p = await probeRefsInRepo(FORGE, [], async () => { called = true; return ok(''); });
  expect(p.status).toBe('ok');
  expect(called).toBe(false);
});

test('probeRefsInRepo: one issue GET per cache miss, PRs and issues alike', async () => {
  const paths: string[] = [];
  const get: ForgejoGet = async (path) => {
    paths.push(path);
    const n = Number(path.split('/').at(-1));
    return ok(n === 260 ? apiPr(n) : apiIssue(n));
  };
  const p = await probeRefsInRepo(FORGE, [260, 42], get);
  expect(p.status).toBe('ok');
  if (p.status === 'ok') {
    expect(p.refs.get(260)?.kind).toBe('pr');
    expect(p.refs.get(42)?.kind).toBe('issue');
  }
  expect(paths).toEqual(['/repos/ultrabricks/tg-cli/issues/260', '/repos/ultrabricks/tg-cli/issues/42']);
});

test('probeRefsInRepo: HTTP 404 is a verified absence, not a whole-probe failure', async () => {
  const p = await probeRefsInRepo(FORGE, [260, 999], async (path) =>
    path.endsWith('/260') ? ok(apiPr(260)) : { status: 404, body: '{"message":"not found"}' });
  expect(p.status).toBe('ok');
  if (p.status === 'ok') {
    expect(p.refs.has(260)).toBe(true);
    expect(p.refs.has(999)).toBe(false);
  }
});

test('probeRefsInRepo: 401/403 → no-auth; other statuses and network failure → error', async () => {
  expect((await probeRefsInRepo(FORGE, [1], async () => ({ status: 401, body: '' }))).status).toBe('no-auth');
  expect((await probeRefsInRepo(FORGE, [1], async () => ({ status: 403, body: '' }))).status).toBe('no-auth');
  expect((await probeRefsInRepo(FORGE, [1], async () => ({ status: 500, body: 'server exploded' }))).status).toBe('error');
  expect((await probeRefsInRepo(FORGE, [1], async () => null)).status).toBe('error');
});

// --- Cache (repo-keyed) ---

const T0 = 1_750_000_000_000;
const REPO = 'ultrabricks/tg-cli';
const ref = (n: number, kind: 'issue' | 'pr' = 'pr'): ForgeRef => ({
  number: n,
  kind,
  title: `Title ${n}`,
  url: `https://git.hyperide.ai/o/r/${kind === 'pr' ? 'pulls' : 'issues'}/${n}`,
  state: kind === 'pr' ? 'MERGED' : 'OPEN',
});
const rawWith = (entries: Record<string, { t: number; info: ForgeRef | null }>): string =>
  JSON.stringify({ entries });

test('cache: key includes the repo', () => {
  expect(cacheKey(REPO, 260)).toBe('ultrabricks/tg-cli#260');
});

test('cache: same number in a different repo is a different entry (miss)', () => {
  const raw = rawWith({ [cacheKey('owner-a/repo', 260)]: { t: T0 - 1000, info: ref(260) } });
  // Lookup under a DIFFERENT repo must miss — the bug this key shape prevents.
  const { hits, missing } = splitByCache('owner-b/repo', [260], raw, T0);
  expect(hits.size).toBe(0);
  expect(missing).toEqual([260]);
});

test('cache: fresh positive entry is a hit', () => {
  const raw = rawWith({ [cacheKey(REPO, 260)]: { t: T0 - 1000, info: ref(260) } });
  const { hits, missing } = splitByCache(REPO, [260], raw, T0);
  expect(hits.get(260)?.title).toBe('Title 260');
  expect(missing).toEqual([]);
});

test('cache: fresh negative entry is a hit (verified-absent)', () => {
  const raw = rawWith({ [cacheKey(REPO, 999)]: { t: T0 - 1000, info: null } });
  const { hits, missing } = splitByCache(REPO, [999], raw, T0);
  expect(hits.has(999)).toBe(true);
  expect(hits.get(999)).toBeNull();
  expect(missing).toEqual([]);
});

test('cache: expired entry is missing (TTL boundary inclusive)', () => {
  const raw = rawWith({ [cacheKey(REPO, 1)]: { t: T0 - CACHE_TTL_MS, info: ref(1) } });
  expect(splitByCache(REPO, [1], raw, T0).missing).toEqual([1]);
});

test('cache: empty repo identity → everything missing', () => {
  const raw = rawWith({ [cacheKey(REPO, 1)]: { t: T0 - 1, info: ref(1) } });
  expect(splitByCache('', [1], raw, T0).missing).toEqual([1]);
});

test('cache: null / corrupt raw → everything missing', () => {
  for (const raw of [null, 'garbage', '[1]', '{"entries":"nope"}']) {
    const { hits, missing } = splitByCache(REPO, [1, 2], raw, T0);
    expect(hits.size).toBe(0);
    expect(missing).toEqual([1, 2]);
  }
});

test('cache merge: probed numbers get positive entries, absent ones negative', () => {
  const refs = new Map([[260, ref(260)]]);
  const raw = mergeIntoCache(null, REPO, [260, 999], refs, T0);
  const { hits, missing } = splitByCache(REPO, [260, 999], raw, T0 + 1000);
  expect(hits.get(260)?.url).toContain('260');
  expect(hits.get(999)).toBeNull();
  expect(missing).toEqual([]);
});

test('cache merge: keeps fresh unrelated entries, prunes expired', () => {
  const old = rawWith({
    [cacheKey(REPO, 1)]: { t: T0 - CACHE_TTL_MS - 5000, info: ref(1) },
    [cacheKey(REPO, 2)]: { t: T0 - 1000, info: ref(2) },
  });
  const raw = mergeIntoCache(old, REPO, [260], new Map([[260, ref(260)]]), T0);
  const parsed = JSON.parse(raw) as { entries: Record<string, unknown> };
  expect(Object.keys(parsed.entries).sort()).toEqual(
    [cacheKey(REPO, 2), cacheKey(REPO, 260)].sort(),
  );
});

test('cache merge: corrupt info shape in old raw is dropped', () => {
  const old = JSON.stringify({ entries: { [cacheKey(REPO, 1)]: { t: T0, info: { number: 1 } } } });
  const { hits, missing } = splitByCache(REPO, [1], old, T0 + 1);
  expect(hits.size).toBe(0);
  expect(missing).toEqual([1]);
});

test('cache: a positive entry missing string state is a miss (no render crash)', () => {
  // A hand-edited/torn entry without `state` must not survive parsing — the
  // render path calls ref.state.toUpperCase() and would crash a real send.
  const old = JSON.stringify({
    entries: {
      [cacheKey(REPO, 1)]: {
        t: T0,
        info: { number: 1, kind: 'pr', title: 't', url: 'https://x.test/1' },
      },
    },
  });
  const { hits, missing } = splitByCache(REPO, [1], old, T0 + 1);
  expect(hits.size).toBe(0);
  expect(missing).toEqual([1]);
});

// --- linkifyRefs ---

const refsMap = (...refs: ForgeRef[]): Map<number, ForgeRef> => new Map(refs.map((r) => [r.number, r]));

test('linkify: wraps a verified ref in an anchor', () => {
  const out = linkifyRefs('done with #260 today', refsMap(ref(260)));
  expect(out).toBe('done with <a href="https://git.hyperide.ai/o/r/pulls/260">#260</a> today');
});

test('linkify: every occurrence is linked', () => {
  const out = linkifyRefs('#1 first, #1 second', refsMap(ref(1)));
  expect(out.match(/<a /g)?.length).toBe(2);
});

test('linkify: unverified refs stay plain', () => {
  const out = linkifyRefs('#1 and #999', refsMap(ref(1)));
  expect(out).toContain('>#1</a>');
  expect(out).not.toContain('>#999</a>');
});

test('linkify: skips tokens containing ://', () => {
  const text = 'https://git.hyperide.ai/o/r/pulls/260';
  expect(linkifyRefs(text, refsMap(ref(260)))).toBe(text);
});

test('linkify: never nests inside an existing <a>', () => {
  const text = '<a href="https://x.test/">about #260 here</a>';
  expect(linkifyRefs(text, refsMap(ref(260)))).toBe(text);
});

test('linkify: skips <pre> and <code> content', () => {
  const text = '<pre>#260</pre> and <code>#260</code> but #260 outside';
  const out = linkifyRefs(text, refsMap(ref(260)));
  expect(out).toContain('<pre>#260</pre>');
  expect(out).toContain('<code>#260</code>');
  expect(out.match(/<a /g)?.length).toBe(1);
});

test('linkify: boundary rules match detection (no x#260, no #260a)', () => {
  const out = linkifyRefs('x#260 #260a', refsMap(ref(260)));
  expect(out).not.toContain('<a ');
});

// --- prStateSuffix / refAnchor ---

test('prStateSuffix: state annotations', () => {
  expect(prStateSuffix(ref(1))).toBe(' (merged)');
  expect(prStateSuffix({ ...ref(2), state: 'CLOSED' })).toBe(' (closed)');
  expect(prStateSuffix({ ...ref(3), state: 'OPEN', isDraft: true })).toBe(' (draft)');
  expect(prStateSuffix({ ...ref(4), state: 'OPEN', isDraft: false })).toBe(' (open)');
});

test('refAnchor: escapes the href', () => {
  const out = refAnchor({ ...ref(1), url: 'https://x.test/?a=1&b="2"' });
  expect(out).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
});

// --- buildEntries ---

test('buildEntries: splits issues and PRs in first-appearance order', () => {
  const map = refsMap(ref(260, 'pr'), ref(42, 'issue'), ref(7, 'pr'));
  const { issues, prs } = buildEntries(map, [260, 42, 7]);
  expect(issues.length).toBe(1);
  expect(issues[0].label).toContain('>#42</a>');
  expect(prs.map((p) => p.label)).toEqual(['<a href="https://git.hyperide.ai/o/r/pulls/260">#260</a>', '<a href="https://git.hyperide.ai/o/r/pulls/7">#7</a>']);
});

// --- Composition through applyAutolink (the real render path) ---

const T = (code: string, title = `Title ${code}`): TicketInfo => ({
  code,
  title,
  url: `https://linear.app/x/issue/${code}/slug`,
});

const linkifyWith = (map: Map<number, ForgeRef>) => (html: string): string => linkifyRefs(html, map);

test('render: a single PR gets its own block even alone', () => {
  const map = refsMap(ref(260, 'pr'));
  const { issues, prs } = buildEntries(map, [260]);
  const out = applyAutolink('shipped #260', [], false, { linkify: linkifyWith(map), issues, prs });
  expect(out).toContain('<a href="https://git.hyperide.ai/o/r/pulls/260">#260</a>');
  expect(out).toContain('<blockquote expandable>PRs:\n');
  expect(out).toContain('#260</a> — Title 260 (merged)');
  expect(out.trimEnd().endsWith('</blockquote>')).toBe(true);
});

test('render: multiple PRs in one block, first-appearance order', () => {
  const map = refsMap(ref(7, 'pr'), ref(8, 'pr'));
  const { issues, prs } = buildEntries(map, [7, 8]);
  const out = applyAutolink('#7 and #8', [], false, { linkify: linkifyWith(map), issues, prs });
  const prBlock = out.slice(out.indexOf('PRs:'));
  expect(prBlock.indexOf('#7')).toBeLessThan(prBlock.indexOf('#8'));
});

test('render: an issue merges into the tickets block (no first-line title)', () => {
  const map = refsMap(ref(42, 'issue'));
  const { issues, prs } = buildEntries(map, [42]);
  const out = applyAutolink('HYP-1 and #42', [T('HYP-1', 'My ticket')], true, {
    linkify: linkifyWith(map),
    issues,
    prs,
  });
  // Both in the SAME blockquote, ticket first then issue.
  const block = out.slice(out.indexOf('<blockquote'));
  expect(block).toContain('HYP-1</a>: My ticket');
  expect(block).toContain('#42</a> — Title 42');
  expect((out.match(/<blockquote expandable>/g) ?? []).length).toBe(1);
  // The single ticket did NOT ride the first line (an issue forced the block).
  expect(out.split('\n')[0]).not.toContain('My ticket');
});

test('render: single ticket with no issues keeps first-line title behavior', () => {
  const out = applyAutolink('shipped HYP-1', [T('HYP-1', 'My ticket')], false);
  expect(out.split('\n')[0]).toBe('My ticket');
});

test('render: mixed ticket + issue + PR — tickets/issues block THEN PRs block', () => {
  const map = refsMap(ref(42, 'issue'), ref(260, 'pr'));
  const { issues, prs } = buildEntries(map, [42, 260]);
  const out = applyAutolink('HYP-1 fixes #42 via #260', [T('HYP-1')], false, {
    linkify: linkifyWith(map),
    issues,
    prs,
  });
  const firstBlock = out.indexOf('<blockquote expandable>');
  const prsBlock = out.indexOf('<blockquote expandable>PRs:');
  expect(firstBlock).toBeGreaterThanOrEqual(0);
  expect(prsBlock).toBeGreaterThan(firstBlock);
  // The first block has the ticket and the issue, not the PR.
  const between = out.slice(firstBlock, prsBlock);
  expect(between).toContain('HYP-1');
  expect(between).toContain('#42');
  expect(between).not.toContain('#260</a> — ');
  // All three are linkified in the body.
  const body = out.slice(0, firstBlock);
  expect(body).toContain('HYP-1</a>');
  expect(body).toContain('#42</a>');
  expect(body).toContain('#260</a>');
});

test('render: no refs/tickets returns body unchanged', () => {
  expect(applyAutolink('hello', [], false, {})).toBe('hello');
});

// --- Hint state backward compat (shared file, forgejo-login kind) ---

test('hint state: old {install,login} file still parses', () => {
  expect(parseHintState('{"install":true,"login":true}')).toEqual({ install: true, login: true });
});

test('hint state: forgejo-login roundtrips beside linear kinds; retired gh-* keys are dropped', () => {
  let s = parseHintState('{"install":true,"gh-install":true,"gh-login":true}');
  expect(s).toEqual({ install: true });
  s = markHint(s, 'forgejo-login');
  expect(parseHintState(serializeHintState(s))).toEqual({ install: true, 'forgejo-login': true });
});
