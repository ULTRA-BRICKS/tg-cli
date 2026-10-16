# Exclusive alert holder (`tg-ctl alert`, tg-cli#747)

One omp session per alert source (rig sysmon) is the **holder**: `tg-ctl alert send
--to-holder` delivers into that session only — never Telegram, never the non-exclusive
subscribers of tg-cli#636. Design: rig-cli `docs/specs/2026-10-15-sysmon-exclusive-subscriber-design.md`,
section *tg-cli: exclusive holder*; usage: `tg-ctl --help` and the README.

## Storage

The holder lives in `<cfg>/tg-ctl.<bot>.alert-subscriptions.json` as `holders` (at most one
per source) next to `subscriptions`, under the same O_EXCL lock and atomic write. Every slot
change (claim, request, grant, deny, take, release) and every liveness refresh runs under
that lock, so two concurrent `subscribe --exclusive` have exactly one winner.

## States

- **bound** — a live omp-live endpoint carries the holder's session id (a resumed session
  keeps the slot under its new pid).
- **suspended** — no endpoint, but one was seen less than 10 minutes ago: `send --to-holder`
  exits 5 and leaves no throttle claim.
- **vacant** — no holder, an expired TTL, no endpoint for 10 minutes, or deliveries failing
  for 10 minutes: `send --to-holder` exits 3; anyone may `take` or `subscribe --exclusive`.

## Handoff

A non-holder runs `handoff-request` (one pending request at a time; a note reaches the
holder — when it cannot, the request is withdrawn and the command exits 5, so an unseen
request never ripens into a take). The holder answers `handoff --to <live session>` or `handoff --deny`; a request left
unanswered for 10 minutes lets its requester `take` the slot.

## Known limits

- Delivery runs outside the store lock: a `send --to-holder` that selected the holder just
  before a handoff may still deliver to the previous holder. The next send goes to the new
  holder.
- The store is forward-compatible only: a pre-#747 tg-ctl (before 1.66.0) that rewrites the
  file drops `holders`.
