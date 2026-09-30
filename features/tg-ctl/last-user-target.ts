// The pane of the CTO's OWN last resolved inbound delivery — distinct from
// tracking the newest OUTBOUND `tg` send from ANY agent pane, including one
// agent proactively messaging the CTO unprompted.
//
// Bug this fixes (tg-cli#78 follow-up, live incident 2026-08-19/20): a non-reply
// inbound from the CTO, arriving right after an unrelated agent (e.g. ext-cc) had
// just sent HIM a message, was binding to THAT agent's pane — because the prior
// mechanism (routes.ts's now-removed `lastMessagePane`) only knew "who last
// spoke", not "who the CTO was last addressing". His own fix, verbatim: "всегда
// есть самое последнее сообщение его и нужно использовать для определения
// адресата" (there's always his own most recent message, and THAT should be
// used to determine the recipient).
//
// This store answers a narrower question than routes.json: not "who sent a message
// last" but "which pane did the CTO's own last message actually land in". It is
// written when an inbound message FROM the CTO resolves to a CONFIRMED delivery
// target — auto-bound (§10 discovery chain), a confirmed reply, or an explicit
// picker/`/agent` selection — never on a failed/unconfirmed delivery attempt and
// never on an agent's own outbound send. (Topic-routed delivery does not yet
// record here — a per-topic pane is a separate, already-unambiguous targeting
// model, tracked as a follow-up rather than folded in here.)
//
// A confirmed delivery to a pane with NO known cwd can't safely record a new
// anchor (there'd be nothing for the pane-id-reuse guard to check) — but the
// daemon INVALIDATES the file in that case rather than silently keeping
// whatever anchor was there before: leaving stale state would make the CTO's
// PRIOR target win over his current one, which is fail-open on the wrong pane,
// not fail-closed (design review finding).
//
// No staleness/expiry check by design: the CTO's stated rule is unconditional
// ("there's ALWAYS his own most recent message"), so `ts` is metadata for
// debugging/future use, not a cutoff — an old-but-still-live anchor is still the
// correct bind.
//
// `cwd` guards against tmux pane-ID reuse (review finding): a pane id like `%5`
// is reused by a totally different project once the original pane closes. The
// caller must compare the STORED cwd against the candidate pane's LIVE path
// (mirroring routeMatchesPane in routes.ts) before trusting `paneId` alone —
// this module only carries the value, it does not validate it (kept pure).
//
// `cwd` is REQUIRED, not optional (architecture review finding): this is a
// brand-new file format with no legacy data to stay compatible with, so a
// record missing/corrupting `cwd` is REJECTED outright (parses to `null`, same
// as a missing/corrupt `paneId`) rather than accepted as a "valid" record that
// can then never resolve. Don't make invalid states representable.
//
// PURE serialization; the daemon owns the actual file I/O (mirrors routes.ts).

export interface LastUserTarget {
  paneId: string;
  cwd: string;
  ts: number; // unix seconds
  sessionKey?: string; // session registry key (session-registry-and-topics §2.4)
}

export function parseLastUserTarget(raw: string | null): LastUserTarget | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  // Empty-string paneId/cwd are rejected too, not just the wrong type: an empty
  // cwd is exactly the value that would let a pane-id-reused resolve slip past
  // the guard if `routeMatchesPane` is ever loosened (review finding) — the
  // parser is the one place that can make that failure mode structurally
  // impossible, so it does, rather than relying on the resolver alone.
  if (
    typeof rec.paneId !== 'string' ||
    rec.paneId === '' ||
    typeof rec.cwd !== 'string' ||
    rec.cwd === '' ||
    typeof rec.ts !== 'number' ||
    !Number.isFinite(rec.ts)
  ) {
    return null;
  }
  return {
    paneId: rec.paneId,
    cwd: rec.cwd,
    ts: rec.ts,
    ...(typeof rec.sessionKey === 'string' && rec.sessionKey ? { sessionKey: rec.sessionKey } : {}),
  };
}

export function serializeLastUserTarget(target: LastUserTarget): string {
  return JSON.stringify(target);
}

// The anchor a confirmed delivery writes, keeping its session registry key (#487):
// the registry's fresh answer for this pane+cwd wins; without one, the current
// anchor's key carries over while it names the same pane and project. `current`
// is read lazily — only when the registry had no answer.
export function withSessionKey(
  next: LastUserTarget,
  resolved: string | null,
  current: () => LastUserTarget | null,
): LastUserTarget {
  if (resolved) return { ...next, sessionKey: resolved };
  const cur = current();
  return cur?.sessionKey && cur.paneId === next.paneId && cur.cwd === next.cwd ? { ...next, sessionKey: cur.sessionKey } : next;
}
