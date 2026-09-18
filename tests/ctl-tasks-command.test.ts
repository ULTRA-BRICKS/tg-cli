import { expect, test } from 'bun:test';
import {
  buildTasksReplyMarkup,
  composeTasksTable,
  composeTasksView,
  filterTasksForView,
  parseTasksCallback,
  tasksCallbackData,
  matchPrsToTasks,
  normalizeTaskStatus,
  parseTasksCommand,
  rollupCiState,
  rollupReviewState,
  statusEmojiForTask,
  taskKey,
  tasksScopeLabel,
  type PrRef,
  type TaskItem,
} from '../features/tg-ctl/tasks-command';
import { hasUnpairedSurrogate } from '../features/tg-ctl/text-util';

test('normalizeTaskStatus: canonical + aliases + non-status', () => {
  expect(normalizeTaskStatus('todo')).toBe('todo');
  expect(normalizeTaskStatus('WIP')).toBe('in-progress');
  expect(normalizeTaskStatus('review')).toBe('in-review');
  expect(normalizeTaskStatus('closed')).toBe('done');
  expect(normalizeTaskStatus('canceled')).toBe('cancelled');
  expect(normalizeTaskStatus('hyperide')).toBeNull();
});

test('parseTasksCommand: bare, status-only, agent-only, both, order-tolerant', () => {
  expect(parseTasksCommand('/tasks')).toEqual({ agent: null, status: null });
  expect(parseTasksCommand('/tasks done')).toEqual({ agent: null, status: 'done' });
  expect(parseTasksCommand('/tasks hyperide')).toEqual({ agent: 'hyperide', status: null });
  expect(parseTasksCommand('/tasks hyperide in-review')).toEqual({ agent: 'hyperide', status: 'in-review' });
  // status first, agent second — still classified correctly
  expect(parseTasksCommand('/tasks wip hyperide')).toEqual({ agent: 'hyperide', status: 'in-progress' });
  // tolerate /tasks@botname
  expect(parseTasksCommand('/tasks@mybot done')).toEqual({ agent: null, status: 'done' });
});

test('rollupCiState: fail dominates, else pending, else pass, empty → null', () => {
  expect(rollupCiState([])).toBeNull();
  expect(rollupCiState(null)).toBeNull();
  expect(
    rollupCiState([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ]),
  ).toBe('fail');
  expect(
    rollupCiState([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'IN_PROGRESS' },
    ]),
  ).toBe('pending');
  expect(rollupCiState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pass');
  // gh sometimes reports a check via `state` instead of conclusion
  expect(rollupCiState([{ state: 'SUCCESS' }])).toBe('pass');
});

const tasks: TaskItem[] = [
  { id: '#117', title: 'A task', state: 'todo', url: 'https://x/117', due: '' },
  { id: '#5', title: 'Another', state: 'in-progress', url: 'https://x/5', due: '2026-07-10' },
];

test('matchPrsToTasks: whole-token match on title or body; highest PR number wins', () => {
  const prs: PrRef[] = [
    { number: 200, url: 'https://x/pr/200', title: 'fix #117 whatever', ci: 'pass' },
    { number: 201, url: 'https://x/pr/201', title: 'unrelated', body: 'Closes #117', ci: 'fail' },
    { number: 5, url: 'https://x/pr/5', title: 'do not match #1170', ci: 'pass' }, // #1170 must NOT match #117
  ];
  const m = matchPrsToTasks(tasks, prs);
  expect(m.get('#117')!.number).toBe(201); // most recent of the two #117 matches
  expect(m.has('#5')).toBe(false); // no PR references #5
});

test('matchPrsToTasks: project-scoped task keys avoid duplicate id collisions', () => {
  const duplicateIds: TaskItem[] = [
    { id: '#1', title: 'tg task', state: 'todo', project: 'alex-mextner/tg-cli' },
    { id: '#1', title: 'rig task', state: 'todo', project: 'alex-mextner/rig-cli' },
    { id: '#1', title: 'unknown project task', state: 'todo' },
  ];
  const m = matchPrsToTasks(duplicateIds, [
    { number: 20, url: 'https://x/pr/20', title: 'fix #1', ci: 'pass', project: 'tg-cli' },
    { number: 21, url: 'https://x/pr/21', title: 'generic fix #1', ci: 'fail' },
  ]);
  expect(m.get(taskKey(duplicateIds[0]))!.number).toBe(20);
  expect(m.has(taskKey(duplicateIds[1]))).toBe(false);
  expect(m.has(taskKey(duplicateIds[2]))).toBe(false);
});

test('matchPrsToTasks: project metadata prevents unique cross-project false links', () => {
  const scoped: TaskItem[] = [
    { id: '#2', title: 'Other repo task', state: 'todo', project: 'other/repo' },
    { id: '#3', title: 'Current repo task', state: 'todo', project: 'alex-mextner/tg-cli' },
  ];
  const m = matchPrsToTasks(scoped, [
    { number: 30, url: 'https://github.com/alex-mextner/tg-cli/pull/30', title: 'fix #2', ci: 'pass', project: 'alex-mextner/tg-cli' },
    { number: 31, url: 'https://github.com/alex-mextner/tg-cli/pull/31', title: 'fix #3', ci: 'pass', project: 'alex-mextner/tg-cli' },
  ]);
  expect(m.has(taskKey(scoped[0]))).toBe(false);
  expect(m.get(taskKey(scoped[1]))!.number).toBe(31);
});

test('matchPrsToTasks: duplicate project fallback uses token boundaries', () => {
  const duplicateIds: TaskItem[] = [
    { id: '#1', title: 'app task', state: 'todo', project: 'app' },
    { id: '#1', title: 'api task', state: 'todo', project: 'api' },
  ];
  const falsePositive = matchPrsToTasks(duplicateIds, [
    { number: 32, url: 'https://x/pr/32', title: 'happy path fix #1', ci: 'pass' },
  ]);
  expect(falsePositive.has(taskKey(duplicateIds[0]))).toBe(false);
  expect(falsePositive.has(taskKey(duplicateIds[1]))).toBe(false);

  const positive = matchPrsToTasks(duplicateIds, [
    { number: 33, url: 'https://x/pr/33', title: 'app fix #1', ci: 'pass' },
  ]);
  expect(positive.get(taskKey(duplicateIds[0]))!.number).toBe(33);
});

test('matchPrsToTasks: owner-qualified projects with the same basename do not collide', () => {
  const sameName: TaskItem[] = [
    { id: '#4', title: 'One owner', state: 'todo', project: 'alice/app' },
    { id: '#5', title: 'Basename only', state: 'todo', project: 'app' },
  ];
  const m = matchPrsToTasks(sameName, [
    { number: 40, url: 'https://github.com/bob/app/pull/40', title: 'fix #4', ci: 'pass', project: 'bob/app' },
    { number: 41, url: 'https://github.com/bob/app/pull/41', title: 'fix #5', ci: 'pass', project: 'bob/app' },
  ]);
  expect(m.has(taskKey(sameName[0]))).toBe(false);
  expect(m.get(taskKey(sameName[1]))!.number).toBe(41);
});

test('matchPrsToTasks: project matching accepts case and filesystem path forms', () => {
  const scoped: TaskItem[] = [
    { id: '#6', title: 'Case-normalized repo', state: 'todo', project: 'Alex-Mextner/TG-CLI' },
    { id: '#7', title: 'Path-backed project', state: 'todo', project: '/Users/alex/xp/tg-cli' },
  ];
  const m = matchPrsToTasks(scoped, [
    { number: 60, url: 'https://github.com/alex-mextner/tg-cli/pull/60', title: 'fix #6', ci: 'pass', project: 'alex-mextner/tg-cli' },
    { number: 70, url: 'https://github.com/alex-mextner/tg-cli/pull/70', title: 'fix #7', ci: 'pass', project: 'alex-mextner/tg-cli' },
  ]);
  expect(m.get(taskKey(scoped[0]))!.number).toBe(60);
  expect(m.get(taskKey(scoped[1]))!.number).toBe(70);
});

test('composeTasksTable: header + one row per task; missing data is an em dash, never fabricated', () => {
  const prs = matchPrsToTasks(tasks, [{ number: 42, url: 'https://x/pr/42', title: 'ref #117', ci: null }]);
  const html = composeTasksTable(tasks, prs, { agent: null, status: null });
  expect(html).toContain('<table>');
  expect(html).toContain('<a href="https://x/117">#117</a>');
  expect(html).toContain('<a href="https://x/pr/42">#42</a>');
  // #117 has no due and a PR whose CI is unknown → em dashes, not "pass"
  expect(html).not.toContain('✓'); // ci null must not render a pass glyph
  expect(html.match(/—/g)!.length).toBeGreaterThanOrEqual(2);
  // #5 has a due date and no PR
  expect(html).toContain('2026-07-10');
});

// tg#17245-class bug: a task title is cut at a fixed 58 UTF-16 code-unit
// count before being HTML-escaped into the table. A naive slice can land
// between the two halves of a surrogate pair (an emoji), orphaning a lone
// surrogate that Telegram's sendMessage rejects wholesale with a 400
// "strings must be encoded in UTF-8". The cut must back up to keep the pair
// whole.
test('composeTasksTable: a title that would split an emoji surrogate pair at the 58-char cut is not orphaned', () => {
  // 56 filler chars + 😀 (\uD83D\uDE00) puts the high surrogate exactly at
  // index 56 — a naive `.slice(0, 57)` keeps it and drops its low-surrogate
  // partner.
  const longTitle = `${'x'.repeat(56)}\ud83d\ude00${'y'.repeat(10)}`;
  const withEmoji: TaskItem[] = [{ id: '#1', title: longTitle, state: 'todo', url: 'https://x/1', due: '' }];
  const html = composeTasksTable(withEmoji, new Map(), { agent: null, status: null });
  expect(html).toContain(`${'x'.repeat(56)}\u2026`);
  expect(hasUnpairedSurrogate(html)).toBe(false);
});

test('rollupReviewState: draft dominates, then the gh reviewDecision enum, else null', () => {
  // A draft PR is not up for review yet, regardless of any decision echo.
  expect(rollupReviewState('APPROVED', true)).toBe('draft');
  expect(rollupReviewState(null, true)).toBe('draft');
  // The three gh reviewDecision values map to lifecycle verdicts.
  expect(rollupReviewState('APPROVED', false)).toBe('approved');
  expect(rollupReviewState('CHANGES_REQUESTED', false)).toBe('changes');
  expect(rollupReviewState('REVIEW_REQUIRED', false)).toBe('review-required');
  // Case-insensitive — the .toUpperCase() normalization is exercised, not just the canonical form.
  expect(rollupReviewState('approved', false)).toBe('approved');
  expect(rollupReviewState('changes_requested', false)).toBe('changes');
  // No reviewers / no review required / unknown → null (rendered as a dash, never fabricated).
  expect(rollupReviewState('', false)).toBeNull();
  expect(rollupReviewState('SOMETHING_ELSE', false)).toBeNull();
  expect(rollupReviewState(null, false)).toBeNull();
  expect(rollupReviewState(undefined, undefined)).toBeNull();
});

test('composeTasksTable: a Review column renders every verdict glyph, em dash when PR/review absent', () => {
  const sample: TaskItem[] = [
    { id: '#1', title: 'Approved work', state: 'in-review', url: 'https://x/1' },
    { id: '#2', title: 'Changes requested', state: 'in-review', url: 'https://x/2' },
    { id: '#3', title: 'Awaiting review', state: 'in-review', url: 'https://x/3' },
    { id: '#4', title: 'Draft PR', state: 'in-progress', url: 'https://x/4' },
    { id: '#5', title: 'PR but no verdict', state: 'in-progress', url: 'https://x/5' },
    { id: '#6', title: 'No PR yet', state: 'todo', url: 'https://x/6' },
  ];
  const prs = new Map<string, PrRef>([
    ['#1', { number: 11, url: 'https://x/pr/11', title: 'ref #1', ci: 'pass', review: 'approved' }],
    ['#2', { number: 12, url: 'https://x/pr/12', title: 'ref #2', ci: 'pass', review: 'changes' }],
    ['#3', { number: 13, url: 'https://x/pr/13', title: 'ref #3', ci: 'pass', review: 'review-required' }],
    ['#4', { number: 14, url: 'https://x/pr/14', title: 'ref #4', ci: 'pending', review: 'draft' }],
    ['#5', { number: 15, url: 'https://x/pr/15', title: 'ref #5', ci: 'pass', review: null }],
  ]);
  const html = composeTasksTable(sample, prs, { agent: null, status: null });
  expect(html).toContain('<th>Review</th>');
  // Every glyph is asserted so a swapped REVIEW_GLYPH key can't pass silently.
  expect(html).toContain('✅'); // approved
  expect(html).toContain('🔁'); // changes requested
  expect(html).toContain('👀'); // awaiting review
  expect(html).toContain('✏️'); // draft
  // The changes glyph must NOT reuse the problem-status red circle (avoid a same-row collision).
  expect(html).not.toContain('🔴');
  // #5 (PR, review null) and #6 (no PR) both render an em dash in the Review cell.
  expect(html.match(/—/g)!.length).toBeGreaterThanOrEqual(2);
});

test('lifecycle table columns stay in lockstep: header th count == row td count == group colspan', () => {
  // Guards the TASKS_TABLE_COLUMNS single-source-of-truth invariant by deriving the counts from
  // the rendered HTML — adding a header/row cell without the colspan (or vice-versa) fails here.
  // A populated PR row (prCell/ci/review filled) exercises the same 7-<td> branch as an empty one.
  const grouped: TaskItem[] = [{ id: '#1', title: 'x', state: 'in-review', url: 'https://x/1', agent: 'a', project: 'p' }];
  const prs = new Map<string, PrRef>([['p:#1', { number: 9, url: 'https://x/pr/9', title: 'ref #1', ci: 'pass', review: 'approved' }]]);
  const html = composeTasksTable(grouped, prs, { agent: null, status: null });
  const headerThs = (html.match(/<th>[^<]*<\/th>/g) ?? []).length;
  const rowTds = (html.match(/<td>/g) ?? []).length;
  const colspan = Number(/<th colspan="(\d+)"/.exec(html)?.[1]);
  expect(headerThs).toBeGreaterThan(0);
  expect(rowTds).toBe(headerThs);
  expect(colspan).toBe(headerThs);
});

test('filterTasksForView: attention default keeps stuck/forgotten tasks, not active or done tasks', () => {
  const sample: TaskItem[] = [
    { id: '#1', title: 'Ready but forgotten', state: 'todo', labels: [], url: '' },
    { id: '#2', title: 'Active implementation', state: 'in-progress', labels: [], url: '' },
    { id: '#3', title: 'Blocked by failing dependency', state: 'in-progress', labels: ['blocked'], url: '' },
    { id: '#4', title: 'Already shipped', state: 'done', labels: [], url: '' },
    { id: '#5', title: 'Done but old blocker label', state: 'done', labels: ['blocked'], url: '' },
  ];
  const prs = new Map<string, PrRef>([['#5', { number: 5, url: '', title: '', ci: 'fail' }]]);
  const filtered = filterTasksForView(sample, prs, 'attention');
  expect(filtered.map((t) => t.id)).toEqual(['#1', '#3']);
  expect(filterTasksForView(sample, prs, 'active').map((t) => t.id)).toEqual(['#2', '#3']);
});

test('filterTasksForView: ready, done, and all filters keep their expected lifecycle slices', () => {
  const sample: TaskItem[] = [
    { id: '#1', title: 'Ready', state: 'todo' },
    { id: '#2', title: 'Active', state: 'in-progress' },
    { id: '#3', title: 'Problem', state: 'todo', labels: ['blocked'] },
    { id: '#4', title: 'Done', state: 'done' },
    { id: '#5', title: 'Cancelled', state: 'cancelled' },
  ];
  expect(filterTasksForView(sample, new Map(), 'ready').map((t) => t.id)).toEqual(['#1']);
  expect(filterTasksForView(sample, new Map(), 'done').map((t) => t.id)).toEqual(['#4']);
  expect(filterTasksForView(sample, new Map(), 'all').map((t) => t.id)).toEqual(['#1', '#2', '#3', '#4', '#5']);
});

test('filterTasksForView: malformed label payloads do not crash the attention view', () => {
  const sample: TaskItem[] = [{ id: '#6', title: 'Odd labels', state: 'todo', labels: { name: 'blocked' } as unknown as string[] }];
  expect(filterTasksForView(sample, new Map(), 'attention').map((t) => t.id)).toEqual(['#6']);
});

test('statusEmojiForTask: compact groups use green/yellow/red/gray prefixes', () => {
  expect(statusEmojiForTask({ id: '#1', title: 'Ready', state: 'todo' }, null)).toBe('🟢');
  expect(statusEmojiForTask({ id: '#2', title: 'Active', state: 'in-progress' }, null)).toBe('🟡');
  expect(statusEmojiForTask({ id: '#3', title: 'Problem', state: 'in-review' }, { number: 9, url: '', title: '', ci: 'fail' })).toBe('🔴');
  expect(statusEmojiForTask({ id: '#4', title: 'Cancelled', state: 'cancelled' }, null)).toBe('⚪');
  expect(statusEmojiForTask({ id: '#5', title: 'Done blocked task', state: 'done', labels: ['blocked'] }, null)).toBe('🟢');
  expect(statusEmojiForTask({ id: '#6', title: 'Add regression coverage', state: 'todo' }, null)).toBe('🟢');
  expect(statusEmojiForTask({ id: '#7', title: 'Overdue task', state: 'todo', due: '2020-01-01' }, null)).toBe('🔴');
});

test('composeTasksView: title cells get emoji prefixes and tasks group by agent plus project', () => {
  const grouped: TaskItem[] = [
    { id: '#10', title: 'tg task', state: 'todo', url: 'https://x/10', agent: 'rig', project: 'alex-mextner/tg-cli' },
    { id: '#11', title: 'rig task', state: 'todo', url: 'https://x/11', agent: 'rig', project: 'alex-mextner/rig-cli' },
    { id: '#12', title: 'ext task', state: 'todo', url: 'https://x/12', agent: 'ext', project: 'alex-mextner/ext-cli' },
  ];
  const view = composeTasksView(grouped, new Map(), { agent: null, status: null }, { view: 'all', page: 0, pageSize: 10 });
  expect(view.html).toContain('rig • tg-cli');
  expect(view.html).toContain('rig • rig-cli');
  expect(view.html).toContain('<th colspan="7">ext</th>');
  expect(view.html).toContain('<td>🟢 tg task</td>');
  expect(view.html.indexOf('rig • rig-cli')).toBeLessThan(view.html.indexOf('rig task'));
  expect(view.html.indexOf('rig • tg-cli')).toBeLessThan(view.html.indexOf('tg task'));
});

test('task quick filters and pagination callbacks round-trip', () => {
  expect(tasksCallbackData('attention', 0)).toBe('tgt:page:attention:0');
  expect(tasksCallbackData('attention', 0, 'filter')).toBe('tgt:filter:attention:0');
  expect(parseTasksCallback('tgt:page:active:2')).toEqual({ view: 'active', page: 2, kind: 'page' });
  expect(parseTasksCallback('tgt:filter:all:0')).toEqual({ view: 'all', page: 0, kind: 'filter' });
  expect(parseTasksCallback('tgt:active:2')).toEqual({ view: 'active', page: 2, kind: 'page' });
  expect(parseTasksCallback('tgt:nope:1')).toBeNull();
  expect(parseTasksCallback('tgt:filter:nope:0')).toBeNull();
  const markup = buildTasksReplyMarkup('attention', 1, 3);
  const flat = markup.inline_keyboard.flat();
  expect(flat.map((b) => b.text)).toContain('Active');
  expect(flat.map((b) => b.callback_data)).toContain('tgt:filter:attention:0');
  expect(flat.map((b) => b.callback_data)).toContain('tgt:page:attention:2');
  expect(buildTasksReplyMarkup('attention', 0, 3).inline_keyboard[1]).toEqual([
    { text: '‹ Prev', callback_data: 'tgt:page:attention:0' },
    { text: '1/3', callback_data: 'tgt:page:attention:0' },
    { text: 'Next ›', callback_data: 'tgt:page:attention:1' },
  ]);
  expect(buildTasksReplyMarkup('attention', 2, 3).inline_keyboard[1]).toEqual([
    { text: '‹ Prev', callback_data: 'tgt:page:attention:1' },
    { text: '3/3', callback_data: 'tgt:page:attention:2' },
    { text: 'Next ›', callback_data: 'tgt:page:attention:2' },
  ]);
});

test('composeTasksView: paginates filtered rows and reports page count', () => {
  const many: TaskItem[] = Array.from({ length: 5 }, (_, i) => ({
    id: `#${i + 1}`,
    title: `Task ${i + 1}`,
    state: 'todo',
    url: '',
    project: 'alex-mextner/tg-cli',
  }));
  const view = composeTasksView(many, new Map(), { agent: null, status: null }, { view: 'attention', page: 1, pageSize: 2 });
  expect(view.page).toBe(1);
  expect(view.totalPages).toBe(3);
  expect(view.html).not.toContain('Task 1');
  expect(view.html).toContain('Task 3');
  expect(view.html).toContain('Task 4');
  expect(view.html).not.toContain('Task 5');
});

test('composeTasksView: missing task state renders without crashing', () => {
  const view = composeTasksView([{ id: '#7', title: 'Missing state' } as TaskItem], new Map(), { agent: null, status: null }, { view: 'all', page: 0, pageSize: 10 });
  expect(view.html).toContain('Missing state');
  expect(view.html).toContain('<td>—</td>');
});

test('composeTasksTable: empty result is explicit, not an empty table', () => {
  const html = composeTasksTable([], new Map(), { agent: 'ghost', status: 'done' });
  expect(html).toContain('No matching tasks');
  expect(html).not.toContain('<table>');
});

test('composeTasksTable: HTML in a title is escaped', () => {
  const evil: TaskItem[] = [{ id: '#9', title: '<script>alert(1)</script>', state: 'todo', url: 'https://x/9' }];
  const html = composeTasksTable(evil, new Map(), { agent: null, status: null });
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
});

// CodeQL js/incomplete-html-attribute-sanitization (PR #120): a task/PR url
// carrying a `"` used to break out of the `href="..."` attribute the row
// builds. Proves the fixed escapeHtml neutralizes it in BOTH attribute
// positions (task url + PR url).
test('composeTasksTable: a `"` (or `\'`) in a url cannot break out of the href attribute', () => {
  const evil: TaskItem[] = [{ id: '#9', title: 'safe', state: 'todo', url: `https://x/9" onmouseover="alert(1)` }];
  const prs = matchPrsToTasks(evil, [
    { number: 1, url: `https://x/pr/1" onmouseover="alert(2)`, title: 'ref #9', ci: null },
  ]);
  const html = composeTasksTable(evil, prs, { agent: null, status: null });
  expect(html).not.toContain('" onmouseover="');
  expect(html).toContain('href="https://x/9&quot; onmouseover=&quot;alert(1)"');
  expect(html).toContain('href="https://x/pr/1&quot; onmouseover=&quot;alert(2)"');
});

test('tasksScopeLabel', () => {
  expect(tasksScopeLabel({ agent: null, status: null })).toBe('Tasks');
  expect(tasksScopeLabel({ agent: 'hyperide', status: 'done' })).toContain('agent <b>hyperide</b>');
  expect(tasksScopeLabel({ agent: null, status: 'done' })).toContain('status <b>done</b>');
});
