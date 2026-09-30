// Live Telegram e2e harness (tg-cli#468) — scenario runner. Drives the CTO's
// Telegram Web client (qa-cli) against the LIVE tg-ctl daemon and fixture agent
// sessions, and reports per-scenario pass / fail / skip with evidence.
//
// All I/O is injected (RunDeps) so the orchestration — prerequisites, cleanup
// on every exit path, the routing-anchor restore — is unit-tested with fakes;
// scripts/e2e-telegram.ts wires the real qa CLI, tmux, abduco and agents.
//
// Every message the harness sends is a Telegram REPLY (ChatClient has no plain
// send): with the bot's threaded mode on, a non-reply message from the client
// opens a NEW topic and starts tg-ctl's spawn wizard (observed live 2026-09-29),
// while a reply to a main-chat message stays in the main chat.

import {
  READY_PREFIX,
  normalizeText,
  restoreDecision,
  scenarioToken,
  transcriptHasNumber,
  type FixtureKind,
  type FixtureSpec,
} from './plan';

export interface ChatMessage {
  id: number;
  out: boolean;
  text: string;
  kind: string;
  status: string | null;
  buttons: string[];
  reactions: string[];
  reply_to_text: string | null;
}

export interface WaitQuery {
  after?: number;
  messageId?: number;
  contains?: string;
  from?: 'peer' | 'me' | 'any';
  timeoutSec: number;
}

// Thrown by ChatClient.wait when nothing matched in time (other errors propagate).
export class WaitTimeout extends Error {}

export interface ChatClient {
  open(): Promise<number>; // latest message id in the bot chat
  reply(replyTo: number, text: string): Promise<ChatMessage>;
  replyWithFile(replyTo: number, path: string): Promise<ChatMessage>;
  tap(messageId: number, label: string): Promise<void>;
  wait(query: WaitQuery): Promise<ChatMessage>;
  screenshot(path: string): Promise<void>;
}

export interface StartedFixture extends FixtureSpec {
  dir: string;
  paneId: string | null; // tmux fixtures
  pid: number | null; // the harness process (omp outside tmux: its omp:<pid> locator)
}

export interface FixtureHost {
  start(spec: FixtureSpec): Promise<StartedFixture>;
  // Answer a known one-time startup dialog (folder trust); returns what it did.
  nudgeStartup(fixture: StartedFixture): Promise<string | null>;
  // Everything the fixture received so far: tmux scrollback or omp transcript text.
  received(fixture: StartedFixture): Promise<string>;
  stop(fixture: StartedFixture): Promise<void>;
}

// The daemon's last-user-target file (the CTO's routing anchor).
export interface AnchorStore {
  read(): string | null;
  write(content: string): void;
}

export interface RunDeps {
  chat: ChatClient;
  host: FixtureHost;
  anchor: AnchorStore;
  voiceFile(n: number): Promise<string>;
  now(): number; // ms
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface RunOptions {
  run: string;
  fixtures: FixtureSpec[];
  voiceNumber: number;
  readyTimeoutSec: number;
  agentTimeoutSec: number; // an agent's `tg` reply
  botTimeoutSec: number; // the daemon's own reply / card edit
  deliveryTimeoutSec: number;
  screenshotPath?: string;
}

export type ScenarioStatus = 'pass' | 'fail' | 'skip';

export interface ScenarioResult {
  name: string;
  status: ScenarioStatus;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface RunReport {
  run: string;
  ok: boolean;
  fixtures: StartedFixture[];
  scenarios: ScenarioResult[];
  anchor: 'restored' | 'kept';
  cleanupErrors: string[];
  // Evidence capture only: a failed screenshot never fails the run.
  screenshotError?: string;
}

export const TOPIC_SKIP_REASON =
  'M4 (#476/#457): tg-ctl topic routing is not implemented for existing sessions yet — an unbound ' +
  'topic drops messages and a client-created topic starts the spawn wizard; the harness stays in the ' +
  'main chat until M4 lands';

class Skip extends Error {}

const snippet = (text: string) => normalizeText(text).slice(0, 160);

export async function runE2E(deps: RunDeps, opts: RunOptions): Promise<RunReport> {
  const { chat, host } = deps;
  const scenarios: ScenarioResult[] = [];
  const started: StartedFixture[] = [];
  const cleanupErrors: string[] = [];
  let screenshotError: string | undefined;
  const ready = new Map<FixtureKind, ChatMessage>();
  // The fixture's newest `tg` message: the reply target for the next step.
  const latest = new Map<FixtureKind, ChatMessage>();
  const savedAnchor = deps.anchor.read();
  let anchorOutcome: RunReport['anchor'] = 'kept';
  let step = 0;

  const record = async (name: string, body: () => Promise<Record<string, unknown>>) => {
    deps.log(`▶ ${name}`);
    try {
      const evidence = await body();
      scenarios.push({ name, status: 'pass', detail: 'ok', evidence });
      deps.log(`✓ ${name}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const status = error instanceof Skip ? 'skip' : 'fail';
      scenarios.push({ name, status, detail, evidence: {} });
      deps.log(`${status === 'skip' ? '–' : '✗'} ${name}: ${detail}`);
    }
  };

  const until = async (probe: () => Promise<boolean>, timeoutSec: number, what: string) => {
    const deadline = deps.now() + timeoutSec * 1000;
    while (!(await probe())) {
      if (deps.now() >= deadline) throw new Error(`timed out after ${timeoutSec}s waiting for ${what}`);
      await deps.sleep(1000);
    }
  };

  const delivered = (f: StartedFixture, token: string) =>
    until(async () => (await host.received(f)).includes(token), opts.deliveryTimeoutSec, `${token} to reach the ${f.kind} fixture`);

  const agentReply = (after: number, contains: string) =>
    chat.wait({ after, contains, from: 'peer', timeoutSec: opts.agentTimeoutSec });

  // The first ready fixture of the preferred kinds, with the message to reply to.
  const fixture = (...kinds: FixtureKind[]): [StartedFixture, ChatMessage] => {
    for (const kind of kinds) {
      const f = started.find((s) => s.kind === kind);
      const replyTo = latest.get(kind);
      if (f && replyTo) return [f, replyTo];
    }
    throw new Skip(`needs a ready ${kinds.join(' or ')} fixture`);
  };

  try {
    const startId = await chat.open();
    for (const spec of opts.fixtures) {
      await record(`start:${spec.kind}`, async () => {
        const f = await host.start(spec);
        started.push(f);
        return { selector: f.selector, paneId: f.paneId, pid: f.pid, dir: f.dir };
      });
    }

    // READY: the fixture agent's first `tg` message proves it runs, can reach
    // Telegram, and registered its pane; it is also the main-chat anchor that
    // every later harness message replies to.
    for (const f of started) {
      await record(`ready:${f.kind}`, async () => {
        const deadline = deps.now() + opts.readyTimeoutSec * 1000;
        const nudges: string[] = [];
        for (;;) {
          // Every fixture's startup dialog is answered on every poll, so one still
          // parked at a trust prompt is not held up behind another's ready wait.
          for (const other of started) {
            const nudge = await host.nudgeStartup(other);
            if (nudge) nudges.push(`${other.kind}: ${nudge}`);
          }
          try {
            // 20 s outlasts qa-cli's 15 s stale-view window, so every poll also
            // re-opens the chat once if Telegram Web stopped rendering new messages.
            const m = await chat.wait({ after: startId, contains: `${READY_PREFIX} ${f.selector}`, from: 'peer', timeoutSec: 20 });
            ready.set(f.kind, m);
            latest.set(f.kind, m);
            return { messageId: m.id, text: snippet(m.text), nudges };
          } catch (error) {
            if (!(error instanceof WaitTimeout) || deps.now() >= deadline) throw error;
          }
        }
      });
    }

    // Explicit `/agent <selector> <text>` routing into each harness.
    for (const f of started) {
      const readyMessage = ready.get(f.kind);
      if (!readyMessage) continue;
      await record(`agent-route:${f.kind}`, async () => {
        const token = scenarioToken(opts.run, ++step);
        const sent = await chat.reply(readyMessage.id, `/agent ${f.selector} ${token} ping`);
        await delivered(f, token);
        const ack = await agentReply(sent.id, `ACK ${token}`);
        latest.set(f.kind, ack);
        return { sent: sent.id, ack: ack.id, ackText: snippet(ack.text) };
      });
    }

    // A Telegram reply to the agent's own message routes back to its session.
    for (const f of started) {
      const agentMessage = latest.get(f.kind);
      if (!agentMessage) continue;
      await record(`reply-route:${f.kind}`, async () => {
        const token = scenarioToken(opts.run, ++step);
        const sent = await chat.reply(agentMessage.id, `${token} reply-route check`);
        await delivered(f, token);
        const ack = await agentReply(sent.id, `ACK ${token}`);
        latest.set(f.kind, ack);
        return { sent: sent.id, ack: ack.id };
      });
    }

    // `/agent <selector>` without text: the "selected" card + its Cancel button.
    await record('agent-picker', async () => {
      const [f, replyTo] = fixture('cc', 'codex', 'omp');
      const sent = await chat.reply(replyTo.id, `/agent ${f.selector}`);
      const card = await chat.wait({ after: sent.id, contains: 'selected ', from: 'peer', timeoutSec: opts.botTimeoutSec });
      if (!normalizeText(card.text).startsWith('selected')) throw new Error(`unexpected reply: ${snippet(card.text)}`);
      const armed = await chat.wait({ messageId: card.id, contains: 'send the next message here', from: 'peer', timeoutSec: opts.botTimeoutSec });
      await chat.tap(card.id, 'Cancel');
      const cancelled = await chat.wait({ messageId: card.id, contains: 'cancelled', from: 'peer', timeoutSec: opts.botTimeoutSec });
      if (!normalizeText(armed.text).includes(f.selector)) {
        throw new Error(`picker selected the wrong session: ${snippet(armed.text)}`);
      }
      return { card: card.id, armed: snippet(armed.text), cancelled: snippet(cancelled.text) };
    });

    // Voice/audio note → local Whisper → transcript routed into the session.
    await record('voice-note', async () => {
      const [f, replyTo] = fixture('omp', 'cc', 'omp-notmux', 'codex');
      const file = await deps.voiceFile(opts.voiceNumber);
      const sent = await chat.replyWithFile(replyTo.id, file);
      const confirmation = await chat.wait({ after: sent.id, contains: '🎤', from: 'peer', timeoutSec: opts.agentTimeoutSec });
      if (!transcriptHasNumber(confirmation.text, opts.voiceNumber)) {
        throw new Error(`transcript lacks ${opts.voiceNumber}: ${snippet(confirmation.text)}`);
      }
      await until(
        async () => {
          const text = await host.received(f);
          const at = text.lastIndexOf('🎤');
          return at >= 0 && transcriptHasNumber(text.slice(at), opts.voiceNumber);
        },
        opts.deliveryTimeoutSec,
        `the transcript to reach the ${f.kind} fixture`,
      );
      const ack = await agentReply(sent.id, 'ACK VOICE');
      latest.set(f.kind, ack);
      return { fixture: f.kind, sent: sent.id, transcript: snippet(confirmation.text), ack: ack.id };
    });

    // AskUserQuestion → PreToolUse hook → question card → button tap → answer.
    await record('question-card', async () => {
      const [f, replyTo] = fixture('cc');
      const token = scenarioToken(opts.run, ++step);
      const sent = await chat.reply(replyTo.id, `/agent ${f.selector} ASK ${token}`);
      const card = await agentReply(sent.id, token);
      if (!card.buttons.includes('Alpha')) throw new Error(`question card has no Alpha button: ${card.buttons.join(', ')}`);
      await chat.tap(card.id, 'Alpha');
      const answered = await chat.wait({ messageId: card.id, contains: 'Selected answer: Alpha', from: 'peer', timeoutSec: opts.botTimeoutSec });
      const answer = await agentReply(card.id, `ANSWER ${token} Alpha`);
      latest.set(f.kind, answer);
      return { card: card.id, buttons: card.buttons, answered: snippet(answered.text), answer: answer.id };
    });

    scenarios.push({ name: 'topic-routing', status: 'skip', detail: TOPIC_SKIP_REASON, evidence: {} });
    if (opts.screenshotPath) {
      await chat.screenshot(opts.screenshotPath).catch((error) => {
        screenshotError = String(error);
      });
    }
  } catch (error) {
    // A step outside `record` (opening the chat) failed: keep the evidence so far.
    const detail = error instanceof Error ? error.message : String(error);
    scenarios.push({ name: 'harness', status: 'fail', detail, evidence: {} });
    deps.log(`✗ harness: ${detail}`);
  } finally {
    for (const f of started) {
      await host.stop(f).catch((error) => cleanupErrors.push(`stop ${f.kind}: ${error}`));
    }
    // The run's explicit routes moved the CTO's anchor onto fixtures; put it back.
    const fixturePanes = started.flatMap((f) => (f.paneId ? [f.paneId] : f.pid ? [`omp:${f.pid}`] : []));
    if (savedAnchor !== null && restoreDecision(savedAnchor, deps.anchor.read(), fixturePanes) === 'restore') {
      deps.anchor.write(savedAnchor);
      anchorOutcome = 'restored';
    }
  }

  const ok = scenarios.every((s) => s.status !== 'fail') && cleanupErrors.length === 0;
  return { run: opts.run, ok, fixtures: started, scenarios, anchor: anchorOutcome, cleanupErrors, screenshotError };
}
