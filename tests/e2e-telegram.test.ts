// Live Telegram e2e harness (tg-cli#468): scenario runner + planning, with a fake
// chat/daemon/fixture world. The live run itself is scripts/e2e-telegram.ts.
import { describe, expect, test } from 'bun:test';
import {
  planFixtures,
  randomToken,
  restoreDecision,
  scenarioToken,
  selectorCollides,
  statusNames,
  transcriptHasNumber,
  type FixtureKind,
  type FixtureSpec,
} from '../features/e2e-telegram/plan';
import { describeLiveOmp } from '../features/tg-ctl/omp';
import { describeUnreachable } from '../features/tg-ctl/unreachable';
import {
  WaitTimeout,
  runE2E,
  type ChatClient,
  type ChatMessage,
  type FixtureHost,
  type RunOptions,
  type RunReport,
  type StartedFixture,
  type WaitQuery,
} from '../features/e2e-telegram/runner';

interface FixtureBehaviour {
  ready?: boolean; // sends its READY message
  ack?: boolean; // answers routed messages
  parked?: boolean; // waits at a startup prompt; sends READY once nudged
}

// A tiny simulation of the bot chat + live daemon + fixture agents: replies
// trigger the daemon/agent behaviour synchronously; wait() only searches.
class World {
  messages: ChatMessage[] = [];
  received = new Map<string, string>();
  stopped: string[] = [];
  taps: string[] = [];
  nudgedAt = new Map<FixtureKind, number>();
  anchor: string | null = JSON.stringify({ paneId: '%2', cwd: '/real/project', ts: 1 });
  clock = 0;
  pickerTarget: string | null = null;
  private nextId = 100;

  constructor(
    readonly fixtures: FixtureSpec[],
    readonly behaviour: Partial<Record<FixtureKind, FixtureBehaviour>> = {},
  ) {}

  private post(text: string, out = false, buttons: string[] = []): ChatMessage {
    const m: ChatMessage = { id: this.nextId++, out, text, kind: 'text', status: out ? 'read' : null, buttons, reactions: [], reply_to_text: null };
    this.messages.push(m);
    return m;
  }

  private behave(kind: FixtureKind): Required<FixtureBehaviour> {
    return { ready: true, ack: true, parked: false, ...this.behaviour[kind] };
  }

  private deliver(f: FixtureSpec, text: string) {
    this.received.set(f.selector, `${this.received.get(f.selector) ?? ''}\n[TG from Alex tg#9] ${text}`);
    this.anchor = JSON.stringify({ paneId: `%fx-${f.selector}`, cwd: `/fx/${f.selector}`, ts: 2 });
  }

  // Which fixture authored an incoming message (by the header we fake).
  private authorOf(id: number): FixtureSpec | undefined {
    const m = this.messages.find((x) => x.id === id);
    return this.fixtures.find((f) => m?.text.startsWith(`[${f.selector}]`));
  }

  chat(): ChatClient {
    return {
      open: async () => {
        for (const f of this.fixtures) {
          const b = this.behave(f.kind);
          if (b.ready && !b.parked) this.post(`[${f.selector}] QA-READY ${f.selector}`);
        }
        return 99;
      },
      reply: async (replyTo, text) => {
        const sent = this.post(text, true);
        const route = text.match(/^\/agent (\S+)(?: (.*))?$/);
        const target = route ? this.fixtures.find((f) => f.selector === route[1]) : this.authorOf(replyTo);
        const body = route ? route[2] ?? '' : text;
        if (!target) return sent;
        if (route && !body) {
          const label = this.pickerTarget ?? target.selector;
          this.post(`selected ${label} · claude — send the next message here`, false, ['Cancel']);
          return sent;
        }
        this.deliver(target, body);
        const token = body.match(/QA\w+/)?.[0];
        if (body.startsWith('ASK ')) {
          this.post(`Question from claude\n${token} pick one`, false, ['Alpha', 'Beta']);
        } else if (token && this.behave(target.kind).ack) {
          this.post(`[${target.selector}] ACK ${token}`);
        }
        return sent;
      },
      replyWithFile: async (replyTo) => {
        const sent = this.post('', true);
        const target = this.authorOf(replyTo);
        this.post('🎤 Расшифровка: Telegram test number forty-two.');
        if (target) {
          this.deliver(target, '🎤 «Telegram test number 42.»');
          this.post(`[${target.selector}] ACK VOICE Telegram test number 42.`);
        }
        return sent;
      },
      tap: async (messageId, label) => {
        this.taps.push(label);
        const card = this.messages.find((m) => m.id === messageId);
        if (!card) throw new Error('no card');
        if (label === 'Cancel') card.text = card.text.replace(/^selected (.*?) — .*/, 'cancelled $1');
        if (label === 'Alpha') {
          card.text += '\nSelected answer: Alpha';
          const token = card.text.match(/QA\w+/)?.[0];
          const cc = this.fixtures.find((f) => f.kind === 'cc');
          if (cc) this.post(`[${cc.selector}] ANSWER ${token} Alpha`);
        }
      },
      wait: async (q: WaitQuery) => {
        const hit = this.messages.find(
          (m) =>
            (q.messageId === undefined || m.id === q.messageId) &&
            (q.after === undefined || q.messageId !== undefined || m.id > q.after) &&
            (q.contains === undefined || m.text.includes(q.contains)) &&
            (q.from !== 'peer' || !m.out),
        );
        if (hit) return hit;
        this.clock += q.timeoutSec * 1000;
        throw new WaitTimeout(`timed out after ${q.timeoutSec}s`);
      },
      screenshot: async () => {},
    };
  }

  host(): FixtureHost {
    return {
      start: async (spec): Promise<StartedFixture> => ({
        ...spec,
        dir: `/fx/${spec.selector}`,
        paneId: spec.inTmux ? `%fx-${spec.selector}` : null,
        pid: spec.inTmux ? null : 4242,
      }),
      nudgeStartup: async (f) => {
        if (!this.behave(f.kind).parked || this.nudgedAt.has(f.kind)) return null;
        this.nudgedAt.set(f.kind, this.clock);
        this.post(`[${f.selector}] QA-READY ${f.selector}`);
        return 'answered the trust prompt';
      },
      received: async (f) => this.received.get(f.selector) ?? '',
      stop: async (f) => {
        this.stopped.push(f.kind);
      },
    };
  }

  run(opts: Partial<RunOptions> = {}) {
    return runE2E(
      {
        chat: this.chat(),
        host: this.host(),
        anchor: { read: () => this.anchor, write: (c) => (this.anchor = c) },
        voiceFile: async () => '/tmp/voice.ogg',
        now: () => this.clock,
        sleep: async (ms) => {
          this.clock += ms;
        },
        log: () => {},
      },
      {
        run: 'r1',
        fixtures: this.fixtures,
        voiceNumber: 42,
        readyTimeoutSec: 30,
        agentTimeoutSec: 30,
        botTimeoutSec: 10,
        deliveryTimeoutSec: 5,
        ...opts,
      },
    );
  }
}

const specs = (kinds: FixtureKind[]): FixtureSpec[] =>
  kinds.map((kind, i) => ({
    kind,
    harness: kind === 'cc' ? 'claude' : 'omp',
    inTmux: kind !== 'omp-notmux',
    selector: `fx${i}bdk`,
  }));

const statusOf = (report: RunReport) =>
  Object.fromEntries(report.scenarios.map((s) => [s.name, s.status]));

describe('runE2E', () => {
  test('a healthy run passes every scenario, skips topics, stops all fixtures and restores the anchor', async () => {
    const world = new World(specs(['omp', 'cc', 'omp-notmux']));
    const saved = world.anchor;
    const report = await world.run();
    expect(statusOf(report)).toEqual({
      'start:omp': 'pass', 'start:cc': 'pass', 'start:omp-notmux': 'pass',
      'ready:omp': 'pass', 'ready:cc': 'pass', 'ready:omp-notmux': 'pass',
      'agent-route:omp': 'pass', 'agent-route:cc': 'pass', 'agent-route:omp-notmux': 'pass',
      'reply-route:omp': 'pass', 'reply-route:cc': 'pass', 'reply-route:omp-notmux': 'pass',
      'agent-picker': 'pass', 'voice-note': 'pass', 'question-card': 'pass', 'topic-routing': 'skip',
    });
    expect(report.ok).toBe(true);
    expect(world.stopped.sort()).toEqual(['cc', 'omp', 'omp-notmux']);
    expect(report.anchor).toBe('restored');
    expect(world.anchor).toBe(saved);
    expect(world.taps).toEqual(['Cancel', 'Alpha']);
  });

  test('a fixture that never reports READY fails alone; the rest still run and everything is cleaned up', async () => {
    const world = new World(specs(['omp', 'cc', 'omp-notmux']), { 'omp-notmux': { ready: false } });
    const report = await world.run();
    const status = statusOf(report);
    expect(status['ready:omp-notmux']).toBe('fail');
    expect(status['agent-route:omp-notmux']).toBeUndefined();
    expect(status['agent-route:cc']).toBe('pass');
    expect(status['question-card']).toBe('pass');
    expect(report.ok).toBe(false);
    expect(world.stopped.sort()).toEqual(['cc', 'omp', 'omp-notmux']);
  });

  test('a fixture parked at a startup prompt is answered while an earlier fixture is still awaited', async () => {
    const world = new World(specs(['omp', 'cc']), { omp: { ready: false }, cc: { parked: true } });
    const report = await world.run();
    const status = statusOf(report);
    expect(status['ready:omp']).toBe('fail');
    expect(status['ready:cc']).toBe('pass');
    // Nudged during omp's ready wait (readyTimeoutSec 30), not after it gave up.
    expect(world.nudgedAt.get('cc')).toBeLessThan(30_000);
  });

  test('delivery without the agent answer is a failure naming the missing ACK', async () => {
    const world = new World(specs(['cc']), { cc: { ack: false } });
    const report = await world.run();
    const route = report.scenarios.find((s) => s.name === 'agent-route:cc');
    expect(route?.status).toBe('fail');
    expect(route?.detail).toContain('timed out');
  });

  test('a picker that armed another session is cancelled and reported as a failure', async () => {
    const world = new World(specs(['cc']));
    world.pickerTarget = 'someone-else';
    const report = await world.run();
    const picker = report.scenarios.find((s) => s.name === 'agent-picker');
    expect(picker?.status).toBe('fail');
    expect(picker?.detail).toContain('wrong session');
    expect(world.taps).toContain('Cancel');
  });

  test('scenarios that need a harness the run does not have are skipped, not failed', async () => {
    const report = await new World(specs(['omp'])).run();
    const status = statusOf(report);
    expect(status['question-card']).toBe('skip');
    expect(status['voice-note']).toBe('pass');
    expect(report.ok).toBe(true);
  });

  test('a newer anchor on a real pane (the CTO routed meanwhile) is never overwritten', async () => {
    const world = new World(specs(['cc']));
    const host = world.host();
    const realNewer = JSON.stringify({ paneId: '%9', cwd: '/real/other', ts: 3 });
    const report = await runE2E(
      {
        chat: world.chat(),
        host: { ...host, stop: async (f) => { await host.stop(f); world.anchor = realNewer; } },
        anchor: { read: () => world.anchor, write: (c) => (world.anchor = c) },
        voiceFile: async () => '/tmp/v.ogg',
        now: () => world.clock,
        sleep: async (ms) => { world.clock += ms; },
        log: () => {},
      },
      { run: 'r1', fixtures: world.fixtures, voiceNumber: 42, readyTimeoutSec: 30, agentTimeoutSec: 30, botTimeoutSec: 10, deliveryTimeoutSec: 5 },
    );
    expect(report.anchor).toBe('kept');
    expect(world.anchor).toBe(realNewer);
  });

  test('fixtures are stopped and the anchor restored even when a scenario step throws', async () => {
    const world = new World(specs(['cc']));
    const host = world.host();
    const saved = world.anchor;
    const report = await runE2E(
      {
        chat: world.chat(),
        host: {
          ...host,
          received: async (f) => {
            const text = await host.received(f);
            if (text.includes('reply-route')) throw new Error('tmux vanished');
            return text;
          },
        },
        anchor: { read: () => world.anchor, write: (c) => (world.anchor = c) },
        voiceFile: async () => '/tmp/v.ogg',
        now: () => world.clock,
        sleep: async (ms) => { world.clock += ms; },
        log: () => {},
      },
      { run: 'r1', fixtures: world.fixtures, voiceNumber: 42, readyTimeoutSec: 30, agentTimeoutSec: 30, botTimeoutSec: 10, deliveryTimeoutSec: 5 },
    );
    expect(report.scenarios.find((s) => s.name === 'reply-route:cc')?.detail).toContain('tmux vanished');
    expect(world.stopped).toEqual(['cc']);
    expect(world.anchor).toBe(saved);
  });

  test('a chat that fails to open still yields a report naming the failure', async () => {
    const world = new World(specs(['cc']));
    const chat = world.chat();
    const report = await runE2E(
      {
        chat: { ...chat, open: async () => { throw new Error('Telegram Web crashed'); } },
        host: world.host(),
        anchor: { read: () => world.anchor, write: (c) => (world.anchor = c) },
        voiceFile: async () => '/tmp/v.ogg',
        now: () => world.clock,
        sleep: async (ms) => { world.clock += ms; },
        log: () => {},
      },
      { run: 'r1', fixtures: world.fixtures, voiceNumber: 42, readyTimeoutSec: 30, agentTimeoutSec: 30, botTimeoutSec: 10, deliveryTimeoutSec: 5 },
    );
    expect(report.ok).toBe(false);
    expect(report.scenarios).toEqual([{ name: 'harness', status: 'fail', detail: 'Telegram Web crashed', evidence: {} }]);
  });

  test('a failed evidence screenshot is reported but does not fail an otherwise passing run', async () => {
    const world = new World(specs(['cc']));
    const chat = world.chat();
    const report = await runE2E(
      {
        chat: { ...chat, screenshot: async () => { throw new Error('render hiccup'); } },
        host: world.host(),
        anchor: { read: () => world.anchor, write: (c) => (world.anchor = c) },
        voiceFile: async () => '/tmp/v.ogg',
        now: () => world.clock,
        sleep: async (ms) => { world.clock += ms; },
        log: () => {},
      },
      { run: 'r1', fixtures: world.fixtures, voiceNumber: 42, readyTimeoutSec: 30, agentTimeoutSec: 30, botTimeoutSec: 10, deliveryTimeoutSec: 5, screenshotPath: '/tmp/chat.png' },
    );
    expect(report.ok).toBe(true);
    expect(report.cleanupErrors).toEqual([]);
    expect(report.screenshotError).toContain('render hiccup');
  });
});

describe('planFixtures', () => {
  const seq = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  test('never picks a selector that /agent would fuzzy-match to a live session', () => {
    const values = [0.01, 0.2, 0.33, 0.47, 0.52, 0.61, 0.74, 0.86, 0.93, 0.11, 0.29, 0.38, 0.44, 0.58, 0.66, 0.79, 0.81, 0.97];
    const first = randomToken(seq(values), 9);
    // A real window whose name is a prefix of the first candidate: tier-1 prefix match.
    const live = [{ windowName: first.slice(0, 5), panePath: '/real/x' }];
    const [spec] = planFixtures(['omp'], live, seq(values));
    expect(spec.selector).not.toBe(first);
    expect(selectorCollides(spec.selector, live)).toBe(false);
  });

  test('fixtures of one run cannot resolve to each other', () => {
    const fixtures = planFixtures(['omp', 'cc', 'omp-notmux', 'codex'], [], Math.random);
    for (const f of fixtures) {
      const others = fixtures.filter((o) => o !== f).map((o) => ({ windowName: o.selector, panePath: `/fx/${o.selector}` }));
      expect(selectorCollides(f.selector, others)).toBe(false);
    }
    expect(fixtures.map((f) => [f.kind, f.inTmux, f.harness])).toEqual([
      ['omp', true, 'omp'], ['cc', true, 'claude'], ['omp-notmux', false, 'omp'], ['codex', true, 'codex'],
    ]);
  });
});

describe('restoreDecision', () => {
  const fx = JSON.stringify({ paneId: '%fx', cwd: '/fx/a', ts: 2 });
  test('restores only an anchor the run moved onto a fixture, and only when there was one before', () => {
    const saved = JSON.stringify({ paneId: '%2', cwd: '/real/project', ts: 1 });
    expect(restoreDecision(saved, fx, ['%fx'])).toBe('restore');
    expect(restoreDecision(null, fx, ['%fx'])).toBe('keep');
    expect(restoreDecision(fx, fx, ['%fx'])).toBe('keep');
    expect(restoreDecision(saved, JSON.stringify({ paneId: '%9', cwd: '/real/other', ts: 3 }), ['%fx'])).toBe('keep');
  });
});

describe('scenarioToken', () => {
  test('no step token is contained in a later one', () => {
    const tokens = Array.from({ length: 30 }, (_, i) => scenarioToken('r1', i + 1));
    for (const a of tokens) for (const b of tokens) if (a !== b) expect(b.includes(a)).toBe(false);
  });
});

describe('statusNames', () => {
  test('reads omp sessions and unreachable agents from tg-ctl status lines', () => {
    const omp = { pid: 7, cwd: '/w/alpha', sessionFile: null, sessionId: null, title: 'Fix login', paneId: null, tty: null };
    const status = [
      'registrations: 1',
      '  - pane %0, cwd /private/tmp',
      `  - ${describeLiveOmp(omp)}`,
      `  - ${describeLiveOmp({ ...omp, instanceId: 'i1', title: 'Ship it', cwd: '/w/beta', paneId: '%4' })}`,
      `  - ${describeUnreachable({ pid: 9, agent: 'claude', tty: 'ttys004', command: 'claude', name: null, cwd: '/w/gamma' })}`,
    ].join('\n');
    expect(statusNames(status)).toEqual([
      { windowName: 'Fix login', panePath: '/w/alpha' },
      { windowName: 'Ship it', panePath: '/w/beta' },
      { windowName: 'gamma', panePath: '/w/gamma' },
    ]);
  });
});

describe('transcriptHasNumber', () => {
  test('accepts digits or words and rejects the number embedded in a longer one', () => {
    expect(transcriptHasNumber('Telegram test number 42.', 42)).toBe(true);
    expect(transcriptHasNumber('Telegram test number forty-two.', 42)).toBe(true);
    expect(transcriptHasNumber('Telegram test number 142.', 42)).toBe(false);
    expect(transcriptHasNumber('Telegram test number forty.', 42)).toBe(false);
  });
});
