#!/usr/bin/env bun
/**
 * Live Telegram end-to-end run for tg-ctl (tg-cli#468).
 *
 * Sends as the CTO from the headless Telegram Web client (qa-cli
 * `qa telegram chat …`, isolated agent-browser session) to the bot, against the
 * LIVE tg-ctl daemon — never a second poller — and fixture agent sessions it
 * creates and removes itself: omp in tmux, Claude Code in tmux, omp outside tmux
 * (abduco pty), optionally codex in tmux. Asserts delivery into the intended
 * fixture (tmux scrollback / omp or cc transcript) and the agent's `tg` reply
 * in the chat, for: /agent routing, reply routing, the /agent picker card and
 * its Cancel button, a voice/audio note (local Whisper), and an AskUserQuestion
 * card button tap. Topic routing is reported as skipped until M4.
 *
 * Wiring only — scenarios, selectors and cleanup rules live in
 * features/e2e-telegram/ (unit-tested). Fixture agents use a cheap model and
 * only ever run `tg`. The run leaves: the chat messages, fixture dirs and the
 * report under ~/.cache/tg-cli-e2e/<run>/. The CTO's routing anchor
 * (last-user-target) is restored when the run moved it onto a fixture.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import {
  DEFAULT_FIXTURES,
  FIXTURE_KICKOFF,
  fixtureInstructions,
  isFixtureKind,
  parseClaudeAuthStatus,
  planFixtures,
  randomToken,
  statusNames,
  voicePhrase,
  type FixtureKind,
  type FixtureSpec,
  type LiveName,
} from '../features/e2e-telegram/plan';
import { claudeHooksInstalled, withClaudeHooks } from '../features/tg-ctl/hook-install';
import {
  TOPIC_SKIP_REASON,
  WaitTimeout,
  runE2E,
  type ChatClient,
  type ChatMessage,
  type FixtureHost,
  type StartedFixture,
} from '../features/e2e-telegram/runner';

const HELP = `usage: bun scripts/e2e-telegram.ts [--dry-run] [--fixtures omp,cc,omp-notmux[,codex]]
                                    [--model <cheap model>] [--codex-model <model>] [--out <dir>]

Live e2e of the tg bot through the CTO's headless Telegram Web client (qa-cli).
Requires: the tg-ctl daemon running (never started here), \`qa telegram login\` done,
\`claude auth login\` done for ~/.claude (cc fixture), tmux, abduco (omp-notmux), omp / claude / codex, say + ffmpeg (voice).

  --dry-run      preflight only: daemon, Telegram Web login, binaries, collision-free
                 /agent selectors; prints the plan; sends nothing, starts nothing
  --fixtures     fixture kinds (default ${DEFAULT_FIXTURES.join(',')}; also: codex)
  --model        model for omp and Claude Code fixtures (default haiku)
  --codex-model  model for the codex fixture (default gpt-5-mini)
  --out          report directory (default ~/.cache/tg-cli-e2e/<run>)

Env: TG_E2E_QA — qa command (default "qa"; e.g. "uv run --project ~/xp/qa-cli qa").
     TG_CTL_CONFIG_DIR — tg-cli config dir (default ~/.config/tg-cli).
Exit: 0 all scenarios passed/skipped, 1 a scenario failed, 2 usage, 3 Telegram Web or
Claude Code (~/.claude) not logged in, 4 tg-ctl daemon not running or a binary missing.`;

const LOCALE_ENV: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  // tmux escapes the -F tab separator without a UTF-8 locale (see tg-ctl SUBPROC_ENV).
  LC_ALL: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutSec?: number } = {}): RunResult {
  const proc = Bun.spawnSync({
    cmd,
    cwd: opts.cwd,
    env: opts.env ?? LOCALE_ENV,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: (opts.timeoutSec ?? 30) * 1000,
  });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

class Blocked extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

function parseArgs(argv: string[]) {
  const opts = { dryRun: false, fixtures: [...DEFAULT_FIXTURES], model: 'haiku', codexModel: 'gpt-5-mini', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Blocked(`${arg} needs a value`, 2);
      return v;
    };
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--fixtures') {
      const kinds = value().split(',');
      const bad = kinds.filter((k) => !isFixtureKind(k));
      if (bad.length) throw new Blocked(`unknown fixture kind(s): ${bad.join(', ')}`, 2);
      // The runner tracks one fixture per kind.
      if (new Set(kinds).size !== kinds.length) throw new Blocked(`duplicate fixture kind in ${kinds.join(',')}`, 2);
      opts.fixtures = kinds.filter(isFixtureKind);
    } else if (arg === '--model') opts.model = value();
    else if (arg === '--codex-model') opts.codexModel = value();
    else if (arg === '--out') opts.out = resolve(value());
    else if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    } else throw new Blocked(`unknown argument ${arg}\n\n${HELP}`, 2);
  }
  for (const m of [opts.model, opts.codexModel]) {
    if (!/^[A-Za-z0-9._/:-]+$/.test(m)) throw new Blocked(`invalid model name ${m}`, 2);
  }
  return opts;
}

// ---- Telegram Web client (qa-cli) ----------------------------------------

class NotLoggedIn extends Error {}

function qaChat(peer: string, username: string): ChatClient {
  const qa = (process.env.TG_E2E_QA || 'qa').split(/\s+/).filter(Boolean);
  const call = (args: string[], timeoutSec = 60) => {
    const r = sh([...qa, 'telegram', 'chat', ...args, '--peer', peer, '--username', username], {
      timeoutSec: timeoutSec + 60,
    });
    let payload: { ok?: boolean; error?: string; [k: string]: unknown } | null = null;
    try {
      payload = JSON.parse(r.stdout.trim().split('\n').pop() || 'null');
    } catch {
      payload = null;
    }
    if (r.code === 0 && payload?.ok) return payload;
    const error = payload?.error || r.stderr.trim() || `qa exited ${r.code}`;
    if (r.code === 3) throw new NotLoggedIn(error);
    if (args[0] === 'wait' && /timed out/.test(error)) throw new WaitTimeout(error);
    throw new Error(`qa telegram chat ${args[0]}: ${error}`);
  };
  // qa prints the message as JSON; validate the fields the runner relies on.
  const message = (payload: Record<string, unknown>): ChatMessage => {
    const m = payload.message;
    if (!m || typeof m !== 'object' || !('id' in m) || typeof m.id !== 'number') {
      throw new Error('qa returned no message');
    }
    const rec: Record<string, unknown> = Object.fromEntries(Object.entries(m));
    const field = <T>(key: string, ok: (v: unknown) => v is T, fallback: T): T => {
      const v = rec[key];
      return ok(v) ? v : fallback;
    };
    const isString = (v: unknown): v is string => typeof v === 'string';
    const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
    return {
      id: m.id,
      out: field('out', (v): v is boolean => typeof v === 'boolean', false),
      text: field('text', isString, ''),
      kind: field('kind', isString, 'text'),
      status: field<string | null>('status', isString, null),
      buttons: field('buttons', isStrings, []),
      reactions: field('reactions', isStrings, []),
      reply_to_text: field<string | null>('reply_to_text', isString, null),
    };
  };
  return {
    async open() {
      const lastId = call(['open']).last_id;
      if (typeof lastId !== 'number') throw new Error(`qa telegram chat open: no last_id in its output (${lastId})`);
      return lastId;
    },
    async reply(replyTo, text) {
      return message(call(['send', '--reply-to', String(replyTo), '--text', text]));
    },
    async replyWithFile(replyTo, path) {
      return message(call(['send-file', '--reply-to', String(replyTo), '--file', path], 120));
    },
    async tap(messageId, label) {
      call(['click', '--message', String(messageId), '--button', label]);
    },
    async wait(q) {
      const args = ['wait', '--from', q.from ?? 'peer', '--timeout', String(q.timeoutSec)];
      if (q.after !== undefined) args.push('--after', String(q.after));
      if (q.messageId !== undefined) args.push('--message', String(q.messageId));
      if (q.contains !== undefined) args.push('--contains', q.contains);
      return message(call(args, q.timeoutSec));
    },
    async screenshot(path) {
      call(['screenshot', '--out', path]);
    },
  };
}

// ---- fixture sessions ----------------------------------------------------

interface Launch {
  model: string;
  codexModel: string;
}

function launchScript(spec: FixtureSpec, dir: string, launch: Launch): string {
  const { model, codexModel } = launch;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const head = `#!/bin/sh\n# tg-cli e2e fixture ${spec.selector} (${spec.kind})\ncd ${q(dir)} || exit 1\necho $$ > agent.pid\n`;
  if (spec.harness === 'omp') {
    return (
      head +
      `exec omp --model ${q(model)} --no-title --no-skills --no-rules --no-lsp --thinking off --tools bash --approval-mode yolo ` +
      `--max-time 30m --session-dir ${q(join(dir, 'sessions'))} --append-system-prompt ${q(join(dir, 'instructions.txt'))} ` +
      `"$(cat kickoff.txt)"\n`
    );
  }
  if (spec.harness === 'claude') {
    // settings.json carries tg-ctl's q→buttons hooks (what `tg-ctl install-hooks` adds),
    // so the question scenario tests the daemon even where ~/.claude lacks them. CLAUDE_CONFIG_DIR
    // is unset so a run started from inside another Claude Code session still uses ~/.claude.
    return (
      head +
      `exec ${CLAUDE_STOCK.map(q).join(' ')} --model ${q(model)} --permission-mode dontAsk --allowedTools 'Bash(tg *)' ` +
      `--settings ${q(join(dir, 'settings.json'))} ` +
      `--append-system-prompt "$(cat instructions.txt)" "$(cat kickoff.txt)"\n`
    );
  }
  return head + `exec codex --model ${q(codexModel)} --dangerously-bypass-approvals-and-sandbox "$(cat instructions.txt; echo; cat kickoff.txt)"\n`;
}

// Every string in an agent's JSONL transcript (escaped text decoded).
function transcriptText(files: string[]): string {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      try {
        walk(JSON.parse(line));
      } catch {
        // partial trailing line while the agent is writing
      }
    }
  }
  return out.join('\n');
}

function jsonlUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => join(dir, rel))
    .filter((p) => p.endsWith('.jsonl') && statSync(p).isFile());
}

// One-time startup dialogs of a fresh fixture dir. Folder trust must be answered
// "Yes" (its default is "No, exit"); Claude Code's external-imports prompt keeps
// its default ("No") — the fixture needs no CLAUDE.md imports.
const CLAUDE_QUESTION_HOOK_CMD = 'tg-ctl ask';

// The cc fixture always runs against the stock config dir: every spawn of claude (the fixture's
// launch script and the login preflight) goes through CLAUDE_STOCK, which unsets CLAUDE_CONFIG_DIR.
const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_STOCK = ['env', '-u', 'CLAUDE_CONFIG_DIR', 'claude'] as const;

// Whether ~/.claude/settings.json forwards AskUserQuestion to tg-ctl
// (unreadable or malformed settings count as "no").
function claudeHasQuestionHook(): boolean {
  const path = join(CLAUDE_DIR, 'settings.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  const settings: Record<string, unknown> = parsed && typeof parsed === 'object' ? Object.fromEntries(Object.entries(parsed)) : {};
  return claudeHooksInstalled(settings, CLAUDE_QUESTION_HOOK_CMD);
}

const TRUST_PROMPT = /Is this a project you created or one you trust|Do you trust the files in this folder|trust the contents of this directory/i;
const IMPORTS_PROMPT = /allow external imports/i;

function liveHost(root: string, run: string, launch: Launch): FixtureHost {
  const alive = (pid: number, dir: string) => sh(['ps', '-o', 'command=', '-p', String(pid)]).stdout.includes(dir);
  return {
    async start(spec) {
      const dir = join(root, spec.selector);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'instructions.txt'), fixtureInstructions(spec, run));
      writeFileSync(join(dir, 'kickoff.txt'), FIXTURE_KICKOFF);
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(withClaudeHooks({}, CLAUDE_QUESTION_HOOK_CMD).settings));
      const script = join(dir, 'run.sh');
      writeFileSync(script, launchScript(spec, dir, launch));
      chmodSync(script, 0o755);
      let paneId: string | null = null;
      if (spec.inTmux) {
        const r = sh(['tmux', 'new-session', '-d', '-s', spec.selector, '-n', spec.selector, '-c', dir, '-P', '-F', '#{pane_id}', script]);
        if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim()}`);
        paneId = r.stdout.trim();
        // Keep a crashed fixture's last screen for the report; stop() kills the session.
        sh(['tmux', 'set-option', '-t', `=${spec.selector}`, 'remain-on-exit', 'on']);
      } else {
        // abduco gives omp the pty its TUI (and the omp-live endpoint) needs; the env
        // drops TMUX/TMUX_PANE so nothing ties it to the harness's own pane.
        const env = { ...LOCALE_ENV };
        delete env.TMUX;
        delete env.TMUX_PANE;
        const r = sh(['abduco', '-n', spec.selector, script], { cwd: dir, env });
        if (r.code !== 0) throw new Error(`abduco failed: ${r.stderr.trim()}`);
      }
      let pid: number | null = null;
      for (let i = 0; i < 20 && pid === null; i++) {
        const raw = existsSync(join(dir, 'agent.pid')) ? readFileSync(join(dir, 'agent.pid'), 'utf8').trim() : '';
        if (/^\d+$/.test(raw)) pid = Number(raw);
        else await Bun.sleep(250);
      }
      return { ...spec, dir, paneId, pid };
    },
    async nudgeStartup(f) {
      if (!f.paneId) return null;
      const pane = f.paneId;
      const screen = () => sh(['tmux', 'capture-pane', '-p', '-J', '-t', pane]).stdout;
      if (TRUST_PROMPT.test(screen())) {
        // Move the ❯/› cursor onto the "Yes" option before confirming.
        for (let i = 0; i < 4; i++) {
          const cursor = screen().split('\n').find((line) => /^\s*[❯›>]\s/.test(line)) ?? '';
          if (/\bYes\b/.test(cursor)) {
            sh(['tmux', 'send-keys', '-t', pane, 'Enter']);
            return 'answered Yes to the folder-trust prompt';
          }
          sh(['tmux', 'send-keys', '-t', pane, 'Down']);
          await Bun.sleep(300);
        }
        throw new Error('could not select "Yes" in the folder-trust prompt');
      }
      if (IMPORTS_PROMPT.test(screen())) {
        sh(['tmux', 'send-keys', '-t', pane, 'Enter']);
        return 'kept external CLAUDE.md imports disabled';
      }
      return null;
    },
    async received(f) {
      const parts: string[] = [];
      if (f.paneId) parts.push(sh(['tmux', 'capture-pane', '-p', '-J', '-S', '-3000', '-t', f.paneId]).stdout);
      if (f.harness === 'omp') parts.push(transcriptText(jsonlUnder(join(f.dir, 'sessions'))));
      if (f.harness === 'claude') {
        const projects = join(CLAUDE_DIR, 'projects');
        const own = existsSync(projects) ? readdirSync(projects).filter((d) => d.endsWith(`-${f.selector}`)) : [];
        parts.push(transcriptText(own.flatMap((d) => jsonlUnder(join(projects, d)))));
      }
      return parts.join('\n');
    },
    async stop(f) {
      if (f.pid !== null && alive(f.pid, f.dir)) {
        process.kill(f.pid, 'SIGTERM');
        for (let i = 0; i < 12 && alive(f.pid, f.dir); i++) await Bun.sleep(250);
        if (alive(f.pid, f.dir)) process.kill(f.pid, 'SIGKILL');
      }
      if (f.inTmux) {
        // `=` makes tmux match the session name exactly — never a prefix of a real session.
        const r = sh(['tmux', 'kill-session', '-t', `=${f.selector}`]);
        if (r.code !== 0 && !/can't find session|no server/.test(r.stderr)) throw new Error(r.stderr.trim());
      } else {
        // abduco's server outlives its child (it keeps the exit status for a client).
        const own = `abduco -n ${f.selector} ${join(f.dir, 'run.sh')}`;
        for (const line of sh(['ps', '-axo', 'pid=,command=']).stdout.split('\n')) {
          const m = line.trim().match(/^(\d+)\s+(.*)$/);
          if (m && m[2] === own) process.kill(Number(m[1]), 'SIGTERM');
        }
      }
    },
  };
}

// ---- preflight -------------------------------------------------------------

function readEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

// Names `/agent` can currently see: tmux windows (+cwd), plus the omp sessions and
// unreachable agents `tg-ctl status` lists.
function liveNames(statusText: string): LiveName[] {
  const names: LiveName[] = sh(['tmux', 'list-panes', '-a', '-F', '#{window_name}\t#{pane_current_path}'])
    .stdout.split('\n')
    .filter(Boolean)
    .map((line) => {
      const [windowName, panePath] = line.split('\t');
      return { windowName, panePath };
    });
  return [...names, ...statusNames(statusText)];
}

// The cc fixture runs `claude` against ~/.claude: refuse up front when that login is gone,
// with the one command that fixes it.
function requireClaudeLogin(): void {
  const status = sh([...CLAUDE_STOCK, 'auth', 'status'], { timeoutSec: 60 });
  const state = parseClaudeAuthStatus(status.stdout);
  if (state === 'logged-in') return;
  if (state === 'logged-out') throw new Blocked('Claude Code is not logged in (~/.claude). Run once, in a terminal:\n  claude auth login', 3);
  const output = (status.stdout + status.stderr).trim().slice(0, 300) || '(no output)';
  throw new Blocked(`cannot tell whether Claude Code is logged in: \`claude auth status\` gave no usable answer (exit ${status.code}): ${output}`, 4);
}

function requireBinaries(kinds: readonly FixtureKind[]): void {
  const needed = new Set(['tmux', 'tg', 'tg-ctl', 'say', 'ffmpeg']);
  for (const kind of kinds) {
    if (kind === 'omp' || kind === 'omp-notmux') needed.add('omp');
    if (kind === 'omp-notmux') needed.add('abduco');
    if (kind === 'cc') needed.add('claude');
    if (kind === 'codex') needed.add('codex');
  }
  const missing = [...needed].filter((bin) => !Bun.which(bin));
  if (missing.length) throw new Blocked(`missing required binaries: ${missing.join(', ')}`, 4);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const configDir = resolve(process.env.TG_CTL_CONFIG_DIR || join(homedir(), '.config', 'tg-cli'));
  const token = readEnvFile(join(configDir, '.env')).TG_BOT_TOKEN ?? '';
  const botId = token.split(':')[0];
  if (!/^\d+$/.test(botId)) throw new Blocked(`no TG_BOT_TOKEN in ${join(configDir, '.env')}`, 4);
  const me: unknown = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
  const bot: Record<string, unknown> =
    me && typeof me === 'object' && 'result' in me && me.result && typeof me.result === 'object'
      ? Object.fromEntries(Object.entries(me.result))
      : {};
  const username = typeof bot.username === 'string' ? bot.username : '';
  if (!username) throw new Blocked('getMe failed: cannot resolve the bot username', 4);

  // The harness exercises the LIVE daemon only; it never starts a poller.
  const status = sh(['tg-ctl', 'status'], { timeoutSec: 60 });
  if (!/^tg-ctl: running\b/m.test(status.stdout)) {
    throw new Blocked(`tg-ctl daemon is not running — start it first (this harness never starts one):\n${status.stdout}`, 4);
  }
  requireBinaries(args.fixtures);
  if (args.fixtures.includes('cc')) requireClaudeLogin();

  const chat = qaChat(botId, username);
  try {
    await chat.open();
  } catch (error) {
    if (error instanceof NotLoggedIn) {
      throw new Blocked('Telegram Web (qa-cli) is not logged in. Run once, in a terminal, and scan the QR:\n  qa telegram login', 3);
    }
    throw error;
  }

  const run = randomToken(Math.random, 5);
  const fixtures = planFixtures(args.fixtures, liveNames(status.stdout), Math.random);
  const out = args.out || join(homedir(), '.cache', 'tg-cli-e2e', run);
  const voiceNumber = 10 + Math.floor(Math.random() * 90);
  const plan = {
    run,
    bot: `@${username} (${botId})`,
    threadedMode: bot.has_topics_enabled === true,
    ...(args.fixtures.includes('cc') ? { claudeForwardsQuestions: claudeHasQuestionHook() } : {}),
    fixtures: fixtures.map((f) => ({ kind: f.kind, selector: f.selector, inTmux: f.inTmux })),
    scenarios: [
      ...fixtures.flatMap((f) => [`start:${f.kind}`, `ready:${f.kind}`, `agent-route:${f.kind}`, `reply-route:${f.kind}`]),
      'agent-picker',
      'voice-note',
      'question-card',
      `topic-routing (skip: ${TOPIC_SKIP_REASON})`,
    ],
    out,
  };
  if (args.dryRun) {
    console.log(JSON.stringify({ dryRun: true, preflight: 'ok', ...plan }, null, 2));
    return 0;
  }

  mkdirSync(out, { recursive: true });
  const anchorPath = join(configDir, `tg-ctl.${botId}.last-user-target.json`);
  const started = Date.now();
  const report = await runE2E(
    {
      chat,
      host: liveHost(join(out, 'fixtures'), run, { model: args.model, codexModel: args.codexModel }),
      anchor: {
        read: () => (existsSync(anchorPath) ? readFileSync(anchorPath, 'utf8') : null),
        write: (content) => {
          const tmp = `${anchorPath}.e2e-${run}`;
          writeFileSync(tmp, content, { mode: 0o600 });
          renameSync(tmp, anchorPath);
        },
      },
      async voiceFile(n) {
        const aiff = join(out, `voice-${n}.aiff`);
        const ogg = join(out, `voice-${n}.ogg`);
        if (sh(['say', '-o', aiff, voicePhrase(n)]).code !== 0) throw new Error('say failed');
        const r = sh(['ffmpeg', '-loglevel', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', ogg]);
        if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim()}`);
        return ogg;
      },
      now: () => Date.now(),
      sleep: (ms) => Bun.sleep(ms),
      log: (line) => console.error(line),
    },
    {
      run,
      fixtures,
      voiceNumber,
      readyTimeoutSec: 240,
      agentTimeoutSec: 180,
      botTimeoutSec: 45,
      deliveryTimeoutSec: 90,
      screenshotPath: join(out, 'chat.png'),
    },
  );
  const full = { ...plan, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), ...report };
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(full, null, 2)}\n`);
  for (const s of report.scenarios) console.log(`${s.status.padEnd(4)}  ${s.name}${s.status === 'pass' ? '' : `  — ${s.detail}`}`);
  console.log(`anchor: ${report.anchor}; cleanup errors: ${report.cleanupErrors.length}; report: ${join(out, 'report.json')}`);
  if (report.screenshotError) console.log(`screenshot failed (run result unaffected): ${report.screenshotError}`);
  return report.ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    if (error instanceof Blocked) {
      console.error(error.message);
      process.exit(error.exitCode);
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  },
);
