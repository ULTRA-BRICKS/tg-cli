# tg-cli — compound autolink refs: ranges & lists (item 7)

Repo: `~/.files/repos/tg-cli`. Shared logic in `features/autolink-refs/compound.ts`,
tests in `tests/autolink-compound.test.ts`. Extends both `autolink-tasks`
(`XXX-ddd` Linear codes) and `autolink-prs` (`#ddd` GitHub refs).

## North star

A single token may pack several references that share a lead:

```
HYP-100..103/110      #5-7,9
```

- **list separators** `/` and `,` → each written number is its own reference;
- **range separators** `..`, `…`, `-` → an inclusive range.

Rendering (decision 2026-06-12 — "в теле ссылки на границы, внизу — все"):

- **in the message body**: leave the text as-is, only *add* links. Every number
  that is **written** (the lead and each number after a separator — i.e. both
  range endpoints) becomes a link; range INTERIOR numbers are not in the text so
  are never linked there.
- **in the bottom reference block**: enumerate **every** number, including the
  full range expansion, each as its own link/line.

So `HYP-100..103` → body links `HYP-100` and `103`; the expandable block lists
`HYP-100, HYP-101, HYP-102, HYP-103` (each verified one).

## Grammar

```
compound := LEAD ( SEP NUMBER )*
LEAD     := [A-Z]{3}-[0-9]+     (ticket)   |   #[1-9][0-9]*   (ref)
SEP      := '..' | '…' | '-'    (range)    |   '/' | ','      (list)
```

The tail numbers are **bare digit runs** — `HYP-1/HYP-2` does NOT merge (the
second lead has letters); it stays two independent single-number groups. A single
`.` is never a separator (a sentence period after a code is not a range), only
`..`/`…` are.

## Path disambiguation (tickets only)

`autolink-tasks` skips file-path-looking codes (`HYP-1.ts:10`, `src/HYP-1/x`) to
avoid corrupting line-spec quote anchors. The `/` list separator collides with
that rule, so compound ticket-lead detection (`ticketLeads`) relaxes it:

- `/` followed by a **digit** → list separator (`HYP-1/2/3` is a ticket list);
- `/` followed by a **letter** → path (`src/HYP-1/x.ts` stays a file mention);
- a leading `/`/`\`, or `.ext`/`.decimal`, still mark a file mention; `..` stays
  a valid range.

GitHub `#refs` never had a path rule, so all separators work there unchanged.
`findCodeMatches` / `findRefMatches` (legacy single-code linkers) are untouched.

## Expansion

`expandGroup` walks the written numbers: list seps append the next number, range
seps fill the inclusive interior. Dedup is within a group; cross-token dedup +
first-appearance order is the detector's job.

**Cap:** `RANGE_STEP_CAP = 100` per range step. A fat-fingered `HYP-1..99999`
drops the interior and keeps only the two endpoints (still linked + listed) — no
100k-line block. A descending range (`HYP-7-3`) degrades to its two endpoints.

## Module API (`features/autolink-refs/compound.ts`)

- `groupsFromLeads(token, leads): CompoundGroup[]` — grow each lead's tail.
- `expandGroup(group): number[]` — all numbers (capped), in order, deduped.
- `linkifyCompound(html, findLeads, urlFor): string` — tag-safe body linkify
  (own walker; never touches `<a>`/`<pre>`/`<code>` or `://` tokens); wraps each
  resolving written span in `<a>`.

Feature wrappers:

- `detectTicketCodesExpanded` / `detectRefsExpanded` — superset of the legacy
  detectors; feed the probe + the bottom block.
- `linkifyTicketsCompound` / `linkifyRefsCompound` — body linkers; for a
  separator-free token they are byte-identical to `linkifyCodes` / `linkifyRefs`.

`applyAutolink` gains an optional `linkifyTickets` override (default = legacy
`linkifyCodes`), so existing callers are unchanged; `tg` passes the compound
linker. The bottom block already enumerates whatever the (now expanded) ticket /
ref list contains.

## Non-goals

- No new write ops; verification is still the existing linear/Forgejo probes (interior
  numbers are probed too, so an absent one stays plain — never invented).
- Lists/ranges across whitespace (`HYP-1 / HYP-2`) are not compound — they are
  separate single tokens by the existing rules.
- No styling — purely link generation (composes with the prefix styling, item 5).
