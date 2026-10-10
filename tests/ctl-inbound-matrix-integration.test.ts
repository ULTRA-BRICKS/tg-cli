// The inbound routing matrix (docs/specs/2026-06-10-tg-ctl-control-design.md,
// 2026-09-30-harness-agnostic-control.md, session-registry-and-topics.md §3.3; AGENTS.md
// "Exactly-once inbound delivery"): every kind of inbound Telegram message × every place an
// agent session can live, against the REAL daemon. Each column is one hermetic world
// (tests/helpers/inbound-world.ts) with exactly one agent of that kind; each row sends one
// message shape and checks what the user and the agent see:
//   delivered — the agent got it exactly once (tagged tg#<id>), the delivery ledger holds one
//               `delivered` record for that message to the session's locator, the history row
//               names the session it went to, and the message earned the 👀 receipt;
//   refused   — nothing reached any agent, no `delivered` record, no 👀, and the user got the
//               reply that says why (fail closed — never a silent drop, never a spawn).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createDaemonRegistry, reapDaemons } from './helpers/daemon-lifecycle';
import {
  callback,
  createWorld,
  documentMsg,
  photoMsg,
  replyTo,
  ROUTE_ANCHOR,
  textMsg,
  TRANSCRIPT,
  voiceMsg,
  waitUntil,
  type World,
  type WorldKind,
} from './helpers/inbound-world';

type Outcome = { deliver: true } | { refuse: RegExp } | null;

// What each world does with a message that reaches routing.
const OMP_FAIL_CLOSED = /Original OMP bridge: endpoint_unavailable[\s\S]*No second agent was started/;
// §5: the unreachable session is named, and the hint says how to make it reachable.
const NO_AGENT_IN_TMUX = (harness: string) =>
  new RegExp(`^No agent in tmux\\. Running OUTSIDE tmux \\(unreachable\\):\\n  - landing · ${harness} — unreachable: not in tmux[\\s\\S]*Restart it with \`rig harness run`);
const OUTSIDE_TMUX_REFUSAL = (harness: string) =>
  new RegExp(`^landing · ${harness} runs outside tmux[\\s\\S]*Restart it with: rig harness run ${harness} --name landing`);

const WORLDS: Record<WorldKind, { plain: Outcome; byName: Outcome; reply: Outcome }> = {
  'omp-tmux-live': { plain: { deliver: true }, byName: { deliver: true }, reply: { deliver: true } },
  'omp-tmux-bare': { plain: { deliver: true }, byName: { deliver: true }, reply: { deliver: true } },
  'omp-notmux-live': { plain: { deliver: true }, byName: { deliver: true }, reply: { deliver: true } },
  'omp-notmux-bare': { plain: { refuse: OMP_FAIL_CLOSED }, byName: { refuse: OMP_FAIL_CLOSED }, reply: { refuse: OMP_FAIL_CLOSED } },
  'claude-tmux': { plain: { deliver: true }, byName: { deliver: true }, reply: { deliver: true } },
  'codex-tmux': { plain: { deliver: true }, byName: { deliver: true }, reply: { deliver: true } },
  'claude-unhosted': { plain: { refuse: NO_AGENT_IN_TMUX('claude') }, byName: { refuse: OUTSIDE_TMUX_REFUSAL('claude') }, reply: null },
  'codex-unhosted': { plain: { refuse: NO_AGENT_IN_TMUX('codex') }, byName: { refuse: OUTSIDE_TMUX_REFUSAL('codex') }, reply: null },
  hosted: { plain: { deliver: true }, byName: { deliver: true }, reply: { deliver: true } },
};

// What the agent received tagged with this inbound message id (the inject wrap's `tg#<id>`).
const deliveriesOf = (w: World, id: number): string[] => w.received().filter((t) => new RegExp(`tg#${id}\\b`).test(t));

// Every action of an update ran: the ledger's `processed` record is written after the batch.
async function settle(w: World, updateId: number): Promise<void> {
  await waitUntil(`update ${updateId} processed`, () => w.ledger().some((e) => e.event === 'processed' && e.update === updateId), 15_000);
}

// The full verdict for one message id once its update was processed.
function expectOutcome(w: World, id: number, outcome: Exclude<Outcome, null>, sentBefore: number, mustContain?: string): void {
  const ledger = w.ledger().filter((e) => e.msg === id);
  const replies = w.api.sent.slice(sentBefore).map((s) => s.text);
  if ('deliver' in outcome) {
    const got = deliveriesOf(w, id);
    expect({ id, got }).toEqual({ id, got: [expect.any(String)] });
    if (mustContain) expect(got[0]).toContain(mustContain);
    expect(ledger.filter((e) => e.event === 'delivered').map((e) => e.target)).toEqual([w.locator]);
    expect(ledger.filter((e) => e.event === 'failed' || e.event === 'uncertain')).toEqual([]);
    expect(w.api.reactions.filter((r) => r.message_id === id).map((r) => r.emoji)).toContain('👀');
    // No failure text reached the user for a message that landed.
    expect(replies.filter((t) => /not delivered|Original OMP bridge|No agent in tmux|runs outside tmux|inject aborted/.test(t))).toEqual([]);
  } else {
    expect(deliveriesOf(w, id)).toEqual([]);
    expect(ledger.filter((e) => e.event === 'delivered')).toEqual([]);
    expect(w.api.reactions.filter((r) => r.message_id === id && r.emoji === '👀')).toEqual([]);
    expect(replies).toContainEqual(expect.stringMatching(outcome.refuse));
  }
  // Nothing was ever spawned to reach a session.
  expect(w.received().filter((t) => t.startsWith('FORBIDDEN SPAWN'))).toEqual([]);
}

// The `tg replies` row of a delivered message names the session it went to (§3.3), in General.
function expectHistory(w: World, id: number, outcome: Exclude<Outcome, null>): void {
  const rows = w.history().filter((r) => r.message_id === id && r.direction === 'user');
  expect(rows).toHaveLength(1);
  expect(rows[0].threadId).toBeNull();
  if ('deliver' in outcome) expect(rows[0].targetAgent).toBe(w.agentName);
}

let nextUpdate = 20_000;
const upd = (message: Record<string, unknown>) => ({ update_id: ++nextUpdate, message });

const reg = createDaemonRegistry();
const worlds: World[] = [];
afterAll(async () => {
  await reapDaemons(reg);
  for (const w of worlds.splice(0)) await w.cleanup();
});

for (const kind of Object.keys(WORLDS) as WorldKind[]) {
  const spec = WORLDS[kind];
  describe(`inbound matrix · ${kind}`, () => {
    let w: World;
    beforeAll(async () => {
      w = await createWorld(kind, reg);
      worlds.push(w);
      await w.start();
    });
    afterAll(async () => {
      await w.stop();
    });

    test('plain text', async () => {
      const before = w.api.sent.length;
      const u = upd(textMsg(101, 'plain text for the agent'));
      w.api.push(u);
      await settle(w, u.update_id);
      expectOutcome(w, 101, spec.plain!, before, 'plain text for the agent');
      expectHistory(w, 101, spec.plain!);
    }, 30_000);

    test.skipIf(spec.reply === null)('reply to the agent’s own message', async () => {
      const before = w.api.sent.length;
      const u = upd(textMsg(102, 'answering your report', replyTo(ROUTE_ANCHOR)));
      w.api.push(u);
      await settle(w, u.update_id);
      expectOutcome(w, 102, spec.reply!, before, 'answering your report');
      expectHistory(w, 102, spec.reply!);
    }, 30_000);

    test('/agent <selector> text', async () => {
      const before = w.api.sent.length;
      const u = upd(textMsg(103, `/agent ${w.selector} routed by name`));
      w.api.push(u);
      await settle(w, u.update_id);
      expectOutcome(w, 103, spec.byName!, before, 'routed by name');
    }, 30_000);

    test('voice note (transcribed)', async () => {
      const before = w.api.sent.length;
      const u = upd(voiceMsg(104));
      w.api.push(u);
      await settle(w, u.update_id);
      // The STT confirmation is posted either way: it says what was heard, not that it landed.
      expect(w.api.sent.slice(before).some((s) => s.text.includes(TRANSCRIPT))).toBe(true);
      expectOutcome(w, 104, spec.plain!, before, TRANSCRIPT);
      expectHistory(w, 104, spec.plain!);
    }, 30_000);

    test('photo with caption', async () => {
      const before = w.api.sent.length;
      const u = upd(photoMsg(105, { caption: 'look at this screen' }));
      w.api.push(u);
      await settle(w, u.update_id);
      expectOutcome(w, 105, spec.plain!, before, 'look at this screen');
      expectHistory(w, 105, spec.plain!);
    }, 30_000);

    test('document', async () => {
      const before = w.api.sent.length;
      const u = upd(documentMsg(106));
      w.api.push(u);
      await settle(w, u.update_id);
      expectOutcome(w, 106, spec.plain!, before);
      expectHistory(w, 106, spec.plain!);
    }, 30_000);

    // After the registry migrated routes.json: a reply must still reach a session the registry does
    // not track (a rig-wrapper host, #536) instead of "that agent is no longer running".
    test.skipIf(spec.reply === null)('photo replying to the agent’s message, after the routes migration', async () => {
      await waitUntil('the routes migration', () => w.routesMigrated(), 15_000);
      const before = w.api.sent.length;
      const u = upd(photoMsg(107, { caption: 'the broken page', ...replyTo(ROUTE_ANCHOR) }));
      w.api.push(u);
      await settle(w, u.update_id);
      expectOutcome(w, 107, spec.reply!, before, 'the broken page');
      expectHistory(w, 107, spec.reply!);
    }, 30_000);

    // An edit Telegram reports for a message that already landed is not a second message.
    test('edited message is never delivered again', async () => {
      const received = w.received().length;
      const ledger = w.ledger().filter((e) => e.msg === 101).length;
      const sent = w.api.sent.length;
      const u = { update_id: ++nextUpdate, edited_message: { ...textMsg(101, 'plain text for the agent (edited)'), edit_date: Math.floor(Date.now() / 1000) } };
      w.api.push(u);
      await settle(w, u.update_id);
      expect(w.received().slice(received)).toEqual([]);
      expect(w.ledger().filter((e) => e.msg === 101)).toHaveLength(ledger);
      expect(w.api.sent.slice(sent)).toEqual([]);
    }, 30_000);

    test('picker tap: bare /agent, tap the session, next message goes there', async () => {
      const before = w.api.sent.length;
      const ask = upd(textMsg(108, '/agent'));
      w.api.push(ask);
      await settle(w, ask.update_id);
      const picker = w.api.sent.slice(before).find((s) => s.buttons.some((b) => b.callback_data.startsWith('tga:')));
      if (kind === 'claude-unhosted' || kind === 'codex-unhosted') {
        // Nothing reachable to pick: no buttons, and the user is told who runs outside tmux.
        expect(picker).toBeUndefined();
        expect(w.api.sent.slice(before).some((s) => s.text.includes('outside tmux'))).toBe(true);
        return;
      }
      expect(picker).toBeDefined();
      const button = picker!.buttons.find((b) => b.callback_data.startsWith('tga:'))!;
      const tap = callback(++nextUpdate, button.callback_data, picker!.id);
      w.api.push(tap);
      await settle(w, tap.update_id);
      const afterTap = w.api.sent.length;
      const u = upd(textMsg(109, 'after the tap'));
      w.api.push(u);
      await settle(w, u.update_id);
      expectOutcome(w, 109, spec.byName!, afterTap, 'after the tap');
    }, 40_000);
  });
}

// Restart replay (AGENTS.md "Exactly-once inbound delivery", spec §10 pending-batch journal), per
// sink: a daemon killed after a message went out — but before it recorded the batch processed —
// replays the journal on start. The message that went out is not sent again; one whose claim the
// kill left open is reported to the user and not sent either; new messages still flow.
const DELIVERING: WorldKind[] = ['omp-tmux-live', 'omp-tmux-bare', 'omp-notmux-live', 'claude-tmux', 'codex-tmux', 'hosted'];
for (const kind of DELIVERING) {
  test(`restart replay · ${kind}: the journal never re-sends what went out or what a kill left in flight`, async () => {
    const w = await createWorld(kind, reg);
    worlds.push(w);
    await w.start();
    const first = upd(textMsg(301, 'went out before the kill'));
    w.api.push(first);
    await settle(w, first.update_id);
    expect(deliveriesOf(w, 301)).toHaveLength(1);
    await w.stop();

    // The kill landed after 301's delivery was recorded but before the batch was marked processed,
    // and while 302's delivery was claimed with no outcome.
    const ledgerPath = join(w.cfgDir, 'tg-ctl.123.delivery.jsonl');
    const kept = readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !(l.includes('"processed"') && l.includes(`"update":${first.update_id}`)));
    const inFlight = upd(textMsg(302, 'in flight when killed'));
    kept.push(JSON.stringify({ ts: Date.now(), event: 'claimed', chat: 1, msg: 302, target: w.locator }));
    writeFileSync(ledgerPath, `${kept.join('\n')}\n`);
    writeFileSync(join(w.cfgDir, 'tg-ctl.123.pending-batch.json'), `${JSON.stringify([first, inFlight])}\n`);

    await w.start();
    const next = upd(textMsg(303, 'after the restart'));
    w.api.push(next);
    await settle(w, next.update_id);
    expect(deliveriesOf(w, 301)).toHaveLength(1);
    expect(deliveriesOf(w, 302)).toEqual([]);
    expect(deliveriesOf(w, 303)).toHaveLength(1);
    expect(w.api.sent.map((s) => s.text)).toContainEqual(expect.stringMatching(new RegExp(`tg#302[\\s\\S]*may not have reached ${w.locator}`)));
    expect(w.ledger().filter((e) => e.msg === 301 && e.event === 'delivered')).toHaveLength(1);
    await w.stop();
  }, 40_000);
}

// The gates in front of every sink (spec §9 allowlist, #183): checked against a live agent, where a
// leak would actually reach the session.
describe('inbound gates · claude in tmux', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld('claude-tmux', reg, { control: '  allowed_senders: 7\n' });
    worlds.push(w);
    await w.start();
  });
  afterAll(async () => {
    await w.stop();
  });

  test('a sender outside the allowlist, in the owner chat, never reaches the agent and gets no answer', async () => {
    const before = w.api.sent.length;
    const u = upd({ ...textMsg(401, 'rm everything'), from: { id: 99, first_name: 'Mallory' } });
    w.api.push(u);
    await settle(w, u.update_id);
    expect(deliveriesOf(w, 401)).toEqual([]);
    expect(w.received().filter((t) => t.includes('rm everything'))).toEqual([]);
    expect(w.api.sent.slice(before)).toEqual([]);
    expect(w.api.reactions.filter((r) => r.message_id === 401)).toEqual([]);
    expect(w.history().filter((r) => r.message_id === 401)).toEqual([]);
    expect(w.ledger().filter((e) => e.msg === 401)).toEqual([]);
  }, 30_000);

  test('an extra allowed sender (control.allowed_senders) reaches the agent', async () => {
    const before = w.api.sent.length;
    const u = upd({ ...textMsg(403, 'from the second operator'), from: { id: 7, first_name: 'Ops' } });
    w.api.push(u);
    await settle(w, u.update_id);
    expectOutcome(w, 403, { deliver: true }, before, 'from the second operator');
  }, 30_000);

  // #183: an owner message Telegram delivers late (daemon downtime) is still a request.
  test('an owner message dated two hours ago is still delivered, once', async () => {
    const before = w.api.sent.length;
    const u = upd({ ...textMsg(404, 'sent while the daemon was down'), date: Math.floor(Date.now() / 1000) - 7200 });
    w.api.push(u);
    await settle(w, u.update_id);
    expectOutcome(w, 404, { deliver: true }, before, 'sent while the daemon was down');
    expect(w.api.sent.slice(before).filter((s) => /stale/.test(s.text))).toEqual([]);
  }, 30_000);

  // #280 (open): an album arrives as one update per photo sharing media_group_id, the caption on the
  // first, in separate getUpdates batches a few hundred ms apart. Grouping happens before any sink,
  // so one world pins it. Kept as a todo body (`bun test --todo` runs it) until #280 lands.
  test.todo('#280: an album (media_group_id) arrives as ONE delivery with both photos and the caption', async () => {
    const first = upd(photoMsg(501, { caption: 'two screens, one bug', media_group_id: 'alb-1' }));
    const second = upd(photoMsg(502, { media_group_id: 'alb-1' }));
    w.api.push(first);
    await settle(w, first.update_id);
    w.api.push(second);
    await settle(w, second.update_id);
    const marker = upd(textMsg(503, 'after the album'));
    w.api.push(marker);
    await waitUntil('the marker', () => deliveriesOf(w, 503).length === 1, 15_000);
    const album = w.received().filter((t) => /tg#50[12]\b/.test(t));
    expect(album).toHaveLength(1);
    expect(album[0]).toContain('two screens, one bug');
    expect(album[0]).toContain(`${first.update_id}.jpg`);
    expect(album[0]).toContain(`${second.update_id}.jpg`);
  }, 30_000);
});
