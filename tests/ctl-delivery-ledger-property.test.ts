// Model-based property test of the inbound delivery ledger (features/tg-ctl/delivery-ledger.ts,
// tg-cli#299/#606). A simulated daemon follows the documented protocol — durable claim, send,
// outcome; on start, every claim without an outcome becomes `uncertain` and every lost picker
// hold `failed` — against an append-only file, while the script replays messages, holds and
// releases them, fails sinks, and kills the daemon at any point, including in the middle of an
// append (a torn last line). Invariant: no message reaches the agent twice, under any
// interleaving.
import { expect, test } from 'bun:test';
import {
  applyLedgerEvents,
  decideDelivery,
  emptyLedgerState,
  type LedgerEvent,
  type LedgerHold,
  type LedgerState,
  ledgerKey,
  ledgerTornTailRepair,
  lostPickerHolds,
  orphanedClaims,
  parseLedger,
  type SinkResult,
  serializeLedgerEvents,
  sinkOutcomeEvent,
} from '../features/tg-ctl/delivery-ledger';
import { arrayOf, forAll, type Gen, int, oneOf, pick, type Rng } from './helpers/prop';

const CHAT = 1;
const TARGET = '%1';

type Op =
  | { op: 'deliver'; msg: number; result: 'ok' | 'failed' | 'uncertain' | 'unsubmitted' }
  | { op: 'hold'; msg: number; hold: LedgerHold }
  | { op: 'restart' };

// Where the next crash lands, drawn per step: none, in the middle of an append, after the claim
// but before the send, or after the send but before its outcome is written.
type Crash = 'none' | 'torn-append' | 'before-send' | 'before-outcome';

class Killed extends Error {}

interface World {
  file: string;
  typed: Map<number, number>; // how many times each message reached the agent
}

class Daemon {
  state: LedgerState;
  constructor(
    private world: World,
    private crash: () => Crash,
    private rng: Rng,
  ) {
    this.state = applyLedgerEvents(emptyLedgerState(), parseLedger(world.file));
    // Same start-up order as runDaemon: repair a torn tail, then settle the dead run's leftovers.
    world.file += ledgerTornTailRepair(world.file);
    for (const c of orphanedClaims(this.state)) this.append({ ts: 0, event: 'uncertain', ...c });
    for (const p of lostPickerHolds(this.state)) this.append({ ts: 0, event: 'failed', ...p, error: 'restart' });
  }

  private append(e: LedgerEvent): void {
    const line = serializeLedgerEvents([e]);
    if (this.crash() === 'torn-append') {
      this.world.file += line.slice(0, int(1, line.length - 1)(this.rng));
      throw new Killed();
    }
    this.world.file += line;
    applyLedgerEvents(this.state, [e]);
  }

  deliver(msg: number, result: Op & { op: 'deliver' }): void {
    const base = { chat: CHAT, msg, target: TARGET };
    const d = decideDelivery(this.state.messages.get(ledgerKey(CHAT, msg)));
    if (d.kind === 'suppress') {
      this.append({ ts: 0, event: 'duplicate', ...base, prior: d.prior.state });
      return;
    }
    this.append({ ts: 0, event: 'claimed', ...base });
    if (this.crash() === 'before-send') throw new Killed();
    // `uncertain` / `unsubmitted`: text bytes reached the agent although the sink failed.
    if (result.result !== 'failed') this.world.typed.set(msg, (this.world.typed.get(msg) ?? 0) + 1);
    if (this.crash() === 'before-outcome') throw new Killed();
    const res: SinkResult =
      result.result === 'ok' ? { ok: true } : result.result === 'uncertain' ? { ok: false, error: 'pty lost', uncertain: true } : result.result === 'unsubmitted' ? { ok: false, error: 'in box', unsubmitted: true } : { ok: false, error: 'pane gone' };
    this.append(sinkOutcomeEvent(0, base, res));
  }

  hold(msg: number, hold: LedgerHold): void {
    this.append({ ts: 0, event: 'queued', chat: CHAT, msg, target: hold === 'picker' ? 'picker' : TARGET, hold });
  }
}

const op: Gen<Op> = oneOf<Op>(
  (rng) => ({ op: 'deliver', msg: int(1, 4)(rng), result: pick(['ok', 'ok', 'ok', 'failed', 'uncertain', 'unsubmitted'] as const)(rng) }),
  (rng) => ({ op: 'deliver', msg: int(1, 4)(rng), result: 'ok' }),
  (rng) => ({ op: 'hold', msg: int(1, 4)(rng), hold: pick(['deferred', 'picker', 'topic-hold'] as const)(rng) }),
  () => ({ op: 'restart' }),
);

const scenario: Gen<{ ops: Op[]; seed: number }> = (rng) => ({ ops: arrayOf(op, 5, 40)(rng), seed: int(0, 2 ** 31)(rng) });

function run({ ops, seed }: { ops: Op[]; seed: number }, crashRate: number): World {
  let s = seed;
  const rng: Rng = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
  const crash = (): Crash => (rng() < crashRate ? pick(['torn-append', 'before-send', 'before-outcome'] as const)(rng) : 'none');
  const world: World = { file: '', typed: new Map() };
  const boot = (): Daemon => {
    for (;;) {
      try {
        return new Daemon(world, crash, rng);
      } catch (err) {
        if (!(err instanceof Killed)) throw err;
      }
    }
  };
  let daemon = boot();
  for (const o of ops) {
    try {
      if (o.op === 'restart') daemon = boot();
      else if (o.op === 'hold') daemon.hold(o.msg, o.hold);
      else daemon.deliver(o.msg, o);
    } catch (err) {
      if (!(err instanceof Killed)) throw err;
      daemon = boot();
    }
  }
  return world;
}

test('no message reaches the agent twice under any interleaving of replays, holds, sink failures and kills', () => {
  forAll('ledger-exactly-once', scenario, (sc) => {
    const world = run(sc, 0.15);
    for (const [msg, n] of world.typed) expect({ msg, n }).toEqual({ msg, n: 1 });
  }, 2000);
});

test('without kills every message delivered with a working sink reaches the agent exactly once', () => {
  forAll('ledger-liveness', scenario, (sc) => {
    const world = run(sc, 0);
    const okMsgs = new Set(sc.ops.flatMap((o) => (o.op === 'deliver' && o.result === 'ok' ? [o.msg] : [])));
    for (const msg of okMsgs) expect({ msg, n: world.typed.get(msg) ?? 0 }).toEqual({ msg, n: 1 });
  }, 500);
});
