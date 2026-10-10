// Per-process facts the daemon reads with one external call per process (tg-cli#537): an agent's
// cwd and the session file it holds open both come from `lsof -p <pid>`, and both only change
// when the process does. A rescan of N live agents then costs one ps + tmux read, not 2N lsof.
//
// A fact is keyed by pid AND the process's command line, so a recycled pid running something else
// never inherits the old process's facts, and it expires after `ttlMs`, so a session switch inside
// one long-lived process is picked up within that window. `retain` drops every pid the latest
// process table no longer shows; the caller runs it after every table read, so only a pid recycled
// by a process with the SAME command line between two table reads could inherit a fact.
// PURE: the caller passes the clock and owns the reads.

export class PidFacts<T> {
  private readonly facts = new Map<number, { command: string; at: number; value: T }>();

  constructor(private readonly ttlMs: number) {}

  get(pid: number, command: string, now: number): T | undefined {
    const fact = this.facts.get(pid);
    if (!fact || fact.command !== command || now - fact.at >= this.ttlMs) return undefined;
    return fact.value;
  }

  // `now`: when the read STARTED. An async read can finish after a later one stored its result;
  // the older read then never replaces it.
  set(pid: number, command: string, value: T, now: number): void {
    const prior = this.facts.get(pid);
    if (prior && prior.command === command && prior.at > now) return;
    this.facts.set(pid, { command, at: now, value });
  }

  // `asOf`: when `livePids` was read. A fact stored by a later read is kept: the older table
  // cannot prove that process gone.
  retain(livePids: Set<number>, asOf: number): void {
    for (const [pid, fact] of this.facts) if (!livePids.has(pid) && fact.at <= asOf) this.facts.delete(pid);
  }
}
