// Live Telegram e2e harness (tg-cli#468) — PURE planning: run tokens, fixture
// selectors that cannot resonate into a real session, the fixture agents'
// instructions, which fixtures this machine can run and which text-to-speech
// engine makes the voice note (tg-cli#563), spoken-number matching for the voice
// scenario, the last-user-target restore decision, and the `claude auth status`
// reading. All I/O lives in scripts/e2e-telegram.ts.
//
// Why selectors are checked against the live window names: `/agent <sel>`
// matches tmux window names FUZZILY (prefix / substring / edit distance, see
// agent-match.ts) and an omp pane's window name is replaced by its title, so an
// omp fixture is only reachable through its exact cwd basename — which a
// partial tier-1 hit on a REAL window would silently beat. A selector is used
// only when `matchWindows` against every other known name returns nothing.

import { matchWindows, type AgentCandidate } from '../tg-ctl/agent-match';
import { parseLastUserTarget } from '../tg-ctl/last-user-target';

export type FixtureKind = 'omp' | 'cc' | 'omp-notmux' | 'codex';
export const FIXTURE_KINDS: readonly FixtureKind[] = ['omp', 'cc', 'omp-notmux', 'codex'];
export const DEFAULT_FIXTURES: readonly FixtureKind[] = ['omp', 'cc', 'omp-notmux'];

export function isFixtureKind(value: string): value is FixtureKind {
  return FIXTURE_KINDS.some((kind) => kind === value);
}

// The binaries a fixture kind needs beyond the harness's own (tmux, tg, tg-ctl).
const FIXTURE_BINARIES: Record<FixtureKind, readonly string[]> = {
  omp: ['omp'],
  'omp-notmux': ['omp', 'abduco'],
  cc: ['claude'],
  codex: ['codex'],
};

export interface FixtureSkip {
  kind: FixtureKind;
  reason: string;
}

export interface FixtureAvailability {
  run: FixtureKind[];
  skipped: FixtureSkip[];
  // Set when the run must not start: a --require'd fixture lacks a binary, or nothing can run.
  error: string | null;
}

// Which selected fixtures this machine can run. A missing harness binary skips only
// that fixture (the runner reports it as a skip row) unless the operator passed
// `--require <kind>`, which also adds the kind to the run when --fixtures lacked it.
export function resolveFixtures(
  selected: readonly FixtureKind[],
  required: readonly FixtureKind[],
  has: (bin: string) => boolean,
): FixtureAvailability {
  const kinds = [...selected, ...required.filter((kind) => !selected.includes(kind))];
  const run: FixtureKind[] = [];
  const skipped: FixtureSkip[] = [];
  const absent: string[] = [];
  const fatal: string[] = [];
  for (const kind of kinds) {
    const missing = FIXTURE_BINARIES[kind].filter((bin) => !has(bin)).join(', ');
    if (!missing) run.push(kind);
    else if (required.includes(kind)) fatal.push(`${missing} (--require ${kind})`);
    else {
      skipped.push({ kind, reason: `${missing} not installed (pass --require ${kind} to make this fatal)` });
      absent.push(`${kind}: ${missing} not installed`);
    }
  }
  const error = fatal.length
    ? `missing required binaries: ${fatal.join('; ')}`
    : run.length
      ? null
      : `no runnable fixture: ${absent.join('; ')}`;
  return { run, skipped, error };
}

// ---- voice note text-to-speech (tg-cli#563) ----------------------------------

export type VoiceEngine = 'say' | 'espeak-ng' | 'espeak' | 'piper' | 'ffmpeg-flite';

export interface VoiceEnv {
  platform: string; // process.platform
  has(bin: string): boolean;
  ffmpegFilters(): string; // `ffmpeg -hide_banner -filters` output; read only when the flite fallback is reached
  piperModel?: string; // TG_E2E_PIPER_MODEL: piper speaks nothing without a voice model
}

export type VoicePlan =
  | { engine: VoiceEngine; synth: { cmd: string[]; stdin?: string }; encode: string[]; ogg: string }
  | { engine: null; reason: string };

export const NO_TTS_REASON =
  'no text-to-speech engine: install espeak-ng (brew install espeak-ng / apt install espeak-ng), espeak, ' +
  'piper with TG_E2E_PIPER_MODEL=<voice.onnx>, or an ffmpeg built with libflite (macOS: say). ' +
  'A generated tone is not used: the scenario checks that Whisper heard the spoken number';

export function ffmpegHasFlite(filters: string): boolean {
  return /^\s*\S+\s+flite\s/m.test(filters);
}

// How to make the voice note for `phrase` at `<base>.ogg` (Opus, as Telegram records
// it): say on macOS, else espeak-ng / espeak / piper, else ffmpeg's own flite filter.
// Without any of them the voice scenario is skipped with the reason, never failed.
export function planVoice(env: VoiceEnv, phrase: string, base: string): VoicePlan {
  if (!env.has('ffmpeg')) return { engine: null, reason: 'ffmpeg not installed (it encodes the voice note to Opus)' };
  const wav = `${base}.wav`;
  const espeak = (['espeak-ng', 'espeak'] as const).find((bin) => env.has(bin));
  let engine: VoiceEngine;
  let synth: { cmd: string[]; stdin?: string };
  let source = wav;
  if (env.platform === 'darwin' && env.has('say')) {
    engine = 'say';
    source = `${base}.aiff`;
    synth = { cmd: ['say', '-o', source, phrase] };
  } else if (espeak) {
    engine = espeak;
    synth = { cmd: [espeak, '-w', wav, phrase] };
  } else if (env.has('piper') && env.piperModel) {
    engine = 'piper';
    synth = { cmd: ['piper', '--model', env.piperModel, '--output_file', wav], stdin: phrase };
  } else if (ffmpegHasFlite(env.ffmpegFilters())) {
    engine = 'ffmpeg-flite';
    // The text sits inside ffmpeg's filtergraph quoting, where ' : , [ ] \ are syntax;
    // only the spoken words matter, so everything else becomes a space.
    const text = phrase.replace(/[^A-Za-z0-9 .]/g, ' ');
    synth = { cmd: ['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `flite=text='${text}'`, wav] };
  } else {
    return { engine: null, reason: NO_TTS_REASON };
  }
  const ogg = `${base}.ogg`;
  const encode = ['ffmpeg', '-loglevel', 'error', '-y', '-i', source, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', ogg];
  return { engine, synth, encode, ogg };
}

export interface FixtureSpec {
  kind: FixtureKind;
  harness: 'omp' | 'claude' | 'codex';
  inTmux: boolean;
  // `/agent` selector == tmux session/window name == cwd basename.
  selector: string;
}

// Consonants + digits only: phoneticKey() leaves them untouched (no c→k, x→ks,
// w→v, y→i folding) so the selector IS its own phonetic key.
const ALPHABET = 'bdfghjkmnprstvz23456789';

export function randomToken(rng: () => number, length: number): string {
  let out = '';
  while (out.length < length) {
    const ch = ALPHABET[Math.floor(rng() * ALPHABET.length) % ALPHABET.length];
    // phoneticKey collapses doubled letters; never generate one.
    if (ch !== out[out.length - 1]) out += ch;
  }
  return out;
}

// A name `/agent` can see: a tmux window (or an omp title) plus its cwd.
export interface LiveName {
  windowName: string;
  panePath?: string;
}

// The agents outside tmux that `tg-ctl status` lists — live omp sessions
// (describeLiveOmp) and unreachable agents (describeUnreachable) — by label and
// cwd. tmux windows come from `tmux list-panes` instead.
export function statusNames(statusText: string): LiveName[] {
  const names: LiveName[] = [];
  for (const m of statusText.matchAll(/^\s+- (.+?) · \S+ — (?:bridge|NO bridge|unreachable: [^(]*) \(.*?\bcwd ([^,]+),/gm)) {
    names.push({ windowName: m[1], panePath: m[2] });
  }
  return names;
}

// True when `/agent <selector>` would match any of `live` (every tier).
export function selectorCollides(selector: string, live: readonly LiveName[]): boolean {
  const candidates: AgentCandidate[] = live.map((l, i) => ({
    paneId: `%live${i}`,
    sessionName: '',
    windowIndex: i,
    windowName: l.windowName,
    agent: 'claude',
    panePath: l.panePath,
  }));
  return matchWindows(selector, candidates).matches.length > 0;
}

// One selector per fixture, each unreachable from every live name AND from the
// other fixtures' selectors; regenerates on a collision.
export function planFixtures(
  kinds: readonly FixtureKind[],
  live: readonly LiveName[],
  rng: () => number,
  maxAttempts = 50,
): FixtureSpec[] {
  // A fixture is visible to /agent by its window name AND its cwd basename.
  const taken: LiveName[] = [];
  return kinds.map((kind) => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const selector = randomToken(rng, 9);
      const self: LiveName = { windowName: selector, panePath: `/fixtures/${selector}` };
      if (selectorCollides(selector, [...live, ...taken])) continue;
      if (taken.some((other) => selectorCollides(other.windowName, [self]))) continue;
      taken.push(self);
      return {
        kind,
        harness: kind === 'cc' ? 'claude' : kind === 'codex' ? 'codex' : 'omp',
        inTmux: kind !== 'omp-notmux',
        selector,
      };
    }
    throw new Error(`could not find a collision-free /agent selector for ${kind} fixture`);
  });
}

// Scenario tokens: `QA<run><n>x` — unique per run and step, plain ASCII so they
// survive the bot's styling and NFKC folding unchanged. The closing `x` (never
// in ALPHABET) keeps step 1's token from being a substring of step 12's.
export function scenarioToken(run: string, step: number): string {
  return `QA${run}${step}x`;
}

export const READY_PREFIX = 'QA-READY';

export function fixtureInstructions(spec: FixtureSpec, run: string): string {
  const ask =
    spec.harness === 'claude'
      ? '   - If it contains "ASK " followed by a token starting with "QA": call the AskUserQuestion tool ' +
        'with ONE question whose text is "<token> pick one" and exactly two options, "Alpha" and "Beta". ' +
        'After the answer arrives, run: tg --reply-to N "ANSWER <token> <chosen option>"\n'
      : '';
  return (
    `You are an automated QA fixture for tg-cli Telegram e2e run ${run}. Your only job is to answer ` +
    'Telegram messages with the `tg` shell command. Never read or edit files, never run any other ' +
    'command, never explain or summarize.\n' +
    `1. Now, run exactly once: tg "${READY_PREFIX} ${spec.selector}"\n` +
    '2. Every later user message containing "[TG from" is a Telegram message. Let N be the number in ' +
    'the LAST "tg#N" on the line that starts with "[TG from". Then:\n' +
    ask +
    '   - Else, if it contains a token starting with "QA": run: tg --reply-to N "ACK <token>"\n' +
    '   - Else (for example a voice transcript after 🎤): run: tg --reply-to N "ACK VOICE <the transcript text>"\n' +
    'Run each command exactly once, then stop and wait for the next message.'
  );
}

export const FIXTURE_KICKOFF = 'Follow your QA fixture instructions: send the ready message now.';

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 10 || n > 99) throw new RangeError('numberWords covers 10..99');
  if (n < 20) return TEENS[n - 10];
  return n % 10 === 0 ? TENS[n / 10] : `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}`;
}

export function voicePhrase(n: number): string {
  return `Telegram test number ${n}.`;
}

// Whisper writes a spoken two-digit number as digits or as words.
export function transcriptHasNumber(transcript: string, n: number): boolean {
  if (new RegExp(`(^|\\D)${n}(\\D|$)`).test(transcript)) return true;
  const words = transcript.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  return ` ${words} `.includes(` ${numberWords(n)} `);
}

// What `claude auth status` said about the login: 'logged-in' / 'logged-out' when it printed a
// JSON object with a boolean `loggedIn`, 'unknown' for everything else (old claude without the
// subcommand, a timeout, unparseable or differently-shaped output) — a caller must not tell the
// operator to log in on 'unknown'. The object may be pretty-printed (nested or not) or on one
// line, with notice lines around it: from the first line starting with `{`, the first prefix
// ending at a `}` line that parses as an object carrying a boolean `loggedIn` decides.
export type ClaudeAuthState = 'logged-in' | 'logged-out' | 'unknown';

export function parseClaudeAuthStatus(stdout: string): ClaudeAuthState {
  const lines = stdout.split('\n');
  for (let first = lines.findIndex((line) => line.startsWith('{')); first >= 0 && first < lines.length; first += 1) {
    if (!lines[first].startsWith('{')) continue;
    for (let last = first; last < lines.length; last += 1) {
      if (!lines[last].trimEnd().endsWith('}')) continue;
      try {
        const parsed: unknown = JSON.parse(lines.slice(first, last + 1).join('\n'));
        if (typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed && typeof parsed.loggedIn === 'boolean') {
          return parsed.loggedIn ? 'logged-in' : 'logged-out';
        }
      } catch {
        continue;
      }
    }
  }
  return 'unknown';
}

// NFKC-fold the bot's Unicode-styled text (bold window names) for matching.
export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

// Restore the CTO's routing anchor only if the run moved it onto a fixture;
// a newer anchor on a real pane (the CTO routed meanwhile) is never touched,
// and with no anchor before the run there is nothing to restore.
export function restoreDecision(
  saved: string | null,
  current: string | null,
  fixturePanes: readonly string[],
): 'restore' | 'keep' {
  const now = parseLastUserTarget(current);
  if (saved === null || !now || !fixturePanes.includes(now.paneId)) return 'keep';
  return saved === current ? 'keep' : 'restore';
}
