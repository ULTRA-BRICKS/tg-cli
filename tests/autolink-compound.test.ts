import { expect, test } from 'bun:test';
import {
  expandGroup,
  groupsFromLeads,
  RANGE_STEP_CAP,
  type CompoundGroup,
} from '../features/autolink-refs/compound';
import {
  detectTicketCodesExpanded,
  ticketLeads,
  detectTicketCodes,
} from '../features/autolink-tasks/detect';
import { linkifyTicketsCompound } from '../features/autolink-tasks/render';
import type { TicketInfo } from '../features/autolink-tasks/linear';
import { detectRefsExpanded } from '../features/autolink-prs/detect';
import { linkifyRefsCompound } from '../features/autolink-prs/render';
import type { ForgeRef } from '../features/autolink-prs/resolve';

// --- expandGroup ---

function group(token: string): CompoundGroup {
  return groupsFromLeads(token, ticketLeads(token))[0];
}

test('expand: list separators add each written number', () => {
  expect(expandGroup(group('HYP-1/3/5'))).toEqual([1, 3, 5]);
  expect(expandGroup(group('HYP-1,3'))).toEqual([1, 3]);
});

test('expand: range separators fill the inclusive interior', () => {
  expect(expandGroup(group('HYP-1..4'))).toEqual([1, 2, 3, 4]);
  expect(expandGroup(group('HYP-5-7'))).toEqual([5, 6, 7]);
  expect(expandGroup(group('HYP-1…3'))).toEqual([1, 2, 3]);
});

test('expand: mixed range then list', () => {
  expect(expandGroup(group('HYP-1..3/9'))).toEqual([1, 2, 3, 9]);
});

test('expand: oversized range keeps only the endpoints (cap)', () => {
  const wide = group(`HYP-1..${1 + RANGE_STEP_CAP + 5}`);
  expect(expandGroup(wide)).toEqual([1, 1 + RANGE_STEP_CAP + 5]);
});

test('expand: descending range degrades to the two endpoints', () => {
  expect(expandGroup(group('HYP-7-3'))).toEqual([7, 3]);
});

// --- detectTicketCodesExpanded ---

test('detect tickets: single code unchanged (superset of detectTicketCodes)', () => {
  expect(detectTicketCodesExpanded('shipped HYP-576')).toEqual(['HYP-576']);
  expect(detectTicketCodesExpanded('shipped HYP-576')).toEqual(detectTicketCodes('shipped HYP-576'));
});

test('detect tickets: list + range expand, first-appearance + dedup', () => {
  expect(detectTicketCodesExpanded('HYP-100..103')).toEqual([
    'HYP-100',
    'HYP-101',
    'HYP-102',
    'HYP-103',
  ]);
  expect(detectTicketCodesExpanded('HYP-1 HYP-1..2')).toEqual(['HYP-1', 'HYP-2']);
});

test('detect tickets: file paths with numeric segments stay file mentions', () => {
  // codex review finding: a '/'+digit must not turn a path+line-spec into a list.
  expect(detectTicketCodesExpanded('see HYP-1/2.ts:10')).toEqual([]);
  expect(detectTicketCodesExpanded('src/HYP-1/2')).toEqual([]);
  expect(detectTicketCodesExpanded('HYP-1/2.ts')).toEqual([]);
  expect(detectTicketCodesExpanded('HYP-1/2:10')).toEqual([]);
  // but a clean list / range / trailing punctuation still works
  expect(detectTicketCodesExpanded('HYP-1/2/3')).toEqual(['HYP-1', 'HYP-2', 'HYP-3']);
  expect(detectTicketCodesExpanded('(HYP-1/2).')).toEqual(['HYP-1', 'HYP-2']);
});

test('detect tickets: pasted URL token still skipped', () => {
  expect(detectTicketCodesExpanded('https://linear.app/x/issue/HYP-1/slug HYP-2/3')).toEqual([
    'HYP-2',
    'HYP-3',
  ]);
});

// --- detectRefsExpanded ---

test('detect refs: range + list expand', () => {
  expect(detectRefsExpanded('#5-7')).toEqual([5, 6, 7]);
  expect(detectRefsExpanded('#100/102')).toEqual([100, 102]);
});

test('detect refs: single ref unchanged', () => {
  expect(detectRefsExpanded('see #260 please')).toEqual([260]);
});

// --- linkifyTicketsCompound (body: written numbers only) ---

const T = (code: string): TicketInfo => ({
  code,
  title: 't',
  url: `https://linear.app/x/issue/${code}`,
});
const tmap = (...codes: string[]): Map<string, TicketInfo> =>
  new Map(codes.map((c) => [c, T(c)]));

test('linkify tickets: single code identical to legacy shape', () => {
  expect(linkifyTicketsCompound('fixed HYP-576', tmap('HYP-576'))).toBe(
    'fixed <a href="https://linear.app/x/issue/HYP-576">HYP-576</a>',
  );
});

test('linkify tickets: range links only the written endpoints', () => {
  // Interior 101/102 are verified too, but absent from the body text → never
  // linked there (they appear only in the bottom block).
  const out = linkifyTicketsCompound('HYP-100..103', tmap('HYP-100', 'HYP-101', 'HYP-102', 'HYP-103'));
  expect(out).toBe(
    '<a href="https://linear.app/x/issue/HYP-100">HYP-100</a>..' +
      '<a href="https://linear.app/x/issue/HYP-103">103</a>',
  );
});

test('linkify tickets: list links every written number', () => {
  const out = linkifyTicketsCompound('HYP-1/2/3', tmap('HYP-1', 'HYP-2', 'HYP-3'));
  expect(out).toBe(
    '<a href="https://linear.app/x/issue/HYP-1">HYP-1</a>/' +
      '<a href="https://linear.app/x/issue/HYP-2">2</a>/' +
      '<a href="https://linear.app/x/issue/HYP-3">3</a>',
  );
});

test('linkify tickets: unverified trailing number stays plain', () => {
  const out = linkifyTicketsCompound('HYP-1/2', tmap('HYP-1'));
  expect(out).toBe('<a href="https://linear.app/x/issue/HYP-1">HYP-1</a>/2');
});

test('linkify tickets: never touches inside <a> or <pre>', () => {
  const html = '<a href="x">HYP-1/2</a> <pre>HYP-3/4</pre>';
  expect(linkifyTicketsCompound(html, tmap('HYP-1', 'HYP-2', 'HYP-3', 'HYP-4'))).toBe(html);
});

// --- linkifyRefsCompound ---

const R = (n: number): ForgeRef => ({
  number: n,
  kind: 'pr',
  title: 't',
  url: `https://gh/pull/${n}`,
  state: 'OPEN',
});
const rmap = (...nums: number[]): Map<number, ForgeRef> => new Map(nums.map((n) => [n, R(n)]));

test('linkify refs: single ref identical to legacy shape', () => {
  expect(linkifyRefsCompound('see #260', rmap(260))).toBe('see <a href="https://gh/pull/260">#260</a>');
});

test('linkify refs: range links endpoints, list links each', () => {
  expect(linkifyRefsCompound('#100..103', rmap(100, 103))).toBe(
    '<a href="https://gh/pull/100">#100</a>..<a href="https://gh/pull/103">103</a>',
  );
  expect(linkifyRefsCompound('#5/6', rmap(5, 6))).toBe(
    '<a href="https://gh/pull/5">#5</a>/<a href="https://gh/pull/6">6</a>',
  );
});
