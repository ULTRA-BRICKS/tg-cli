// Control-channel config for tg-ctl (spec §9).
//
// Same philosophy as features/auto-attach/feature-flags.ts: the config file is
// a top-level `control:` block of one-level `  key: value` scalars, so a tiny
// hand-rolled reader beats a yaml dependency (package.json intentionally has
// only bun-types). Anything outside that exact shape is ignored.
//
// Everything here is PURE — the config.yaml file I/O lives in the tg-ctl
// entrypoint, which hands the already-read contents to parseControlConfig.

import { DEFAULT_CONTROL, type ControlConfig } from './types';

// Same boolean token sets as the features: block parser (they are module-
// private there; the contract is the values, not the Set instance).
const TRUE_TOKENS = new Set(['true', 'yes', 'on', '1']);
const FALSE_TOKENS = new Set(['false', 'no', 'off', '0']);

// 'channel' is reserved for v1.2+ but type-valid — resolve keeps it; the v1
// entrypoint decides what an unimplemented transport means.
const TRANSPORTS = new Set<string>(['auto', 'tmux', 'channel']);

const unquote = (s: string): string => s.replace(/^["']|["']$/g, '');

// Strict non-negative integer literal — Number() alone would accept '1e3',
// '0x10', '-5' and ''. Positivity is resolve's job, not the parser's.
const INT_RE = /^\d+$/;

// Static key → field tables. A Map, not an object literal: `constructor`/`toString` in a config
// file must stay "unknown key", never resolve to an inherited Object.prototype member.
const BOOLEAN_KEYS = new Map<string, 'enabled' | 'topics' | 'privateTopics' | 'gitStateBanner'>([
  ['enabled', 'enabled'],
  ['topics', 'topics'],
  ['private_topics', 'privateTopics'],
  ['git_state_banner', 'gitStateBanner'],
]);
const INT_KEYS = new Map<string, 'stalenessSec' | 'idleExitMin'>([
  ['staleness_sec', 'stalenessSec'],
  ['idle_exit_min', 'idleExitMin'],
]);
const TEXT_KEYS = new Map<string, 'session' | 'injectWrap'>([
  ['session', 'session'],
  ['inject_wrap', 'injectWrap'],
]);
// Remote ctl server keys stay RAW (trimmed, quotes stripped; empty = unset). Their rules live
// once, in `tg-remote config check` (remote-config.ts), not in a second TS validator.
const REMOTE_KEYS = new Map<string, 'server' | 'machine' | 'remoteMachines'>([
  ['server', 'server'],
  ['machine', 'machine'],
  ['remote_machines', 'remoteMachines'],
]);

// `key: value` pairs of the top-level `control:` block (one-level scalars only). Anything outside
// that exact shape — other blocks, comments, empty values — yields nothing.
function* controlEntries(yaml: string): Generator<[string, string]> {
  let inControl = false;
  for (const rawLine of yaml.split('\n')) {
    // Strip trailing comments (only when clearly a comment, not inside a value).
    const line = rawLine.replace(/\s+#.*$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (line.length === line.trimStart().length) {
      // A top-level key. We only care about `control:`.
      inControl = trimmed.replace(/:.*$/, '') === 'control';
      continue;
    }
    const colon = trimmed.indexOf(':');
    const value = trimmed.slice(colon + 1).trim();
    if (inControl && colon !== -1 && value) yield [unquote(trimmed.slice(0, colon).trim()), value];
  }
}

function applyControlKey(out: Partial<ControlConfig>, key: string, value: string): void {
  const flag = BOOLEAN_KEYS.get(key);
  if (flag) {
    // unrecognized value → ignore (don't guess)
    const token = value.toLowerCase();
    if (TRUE_TOKENS.has(token)) out[flag] = true;
    else if (FALSE_TOKENS.has(token)) out[flag] = false;
    return;
  }
  const count = INT_KEYS.get(key);
  if (count) {
    if (INT_RE.test(value)) out[count] = Number(value);
    return;
  }
  const text = TEXT_KEYS.get(key);
  if (text) {
    out[text] = unquote(value);
    return;
  }
  const remote = REMOTE_KEYS.get(key);
  if (remote) {
    const raw = unquote(value).trim();
    if (raw) out[remote] = raw;
    return;
  }
  // Raw string passthrough — resolveControlConfig normalizes garbage.
  if (key === 'transport') out.transport = unquote(value) as ControlConfig['transport'];
  else if (key === 'allowed_senders') {
    out.allowedSenders = unquote(value)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => INT_RE.test(s))
      .map(Number);
  }
  // unknown key → ignore
}

export function parseControlConfig(yaml: string): Partial<ControlConfig> {
  const out: Partial<ControlConfig> = {};
  for (const [key, value] of controlEntries(yaml)) applyControlKey(out, key, value);
  return out;
}

// Merge a parsed partial over the defaults, healing invalid values: a
// transport outside the union → 'auto'; staleness_sec / idle_exit_min must be
// positive integers or the default wins. Healing lives here (not in the
// parser) so programmatic callers get the same guarantees as config files.
export function resolveControlConfig(partial: Partial<ControlConfig>): ControlConfig {
  const posInt = (v: number | undefined, dflt: number): number =>
    v !== undefined && Number.isInteger(v) && v > 0 ? v : dflt;

  const cfg: ControlConfig = {
    enabled: partial.enabled ?? DEFAULT_CONTROL.enabled,
    transport:
      partial.transport !== undefined && TRANSPORTS.has(partial.transport)
        ? partial.transport
        : 'auto',
    injectWrap: partial.injectWrap ?? DEFAULT_CONTROL.injectWrap,
    stalenessSec: posInt(partial.stalenessSec, DEFAULT_CONTROL.stalenessSec),
    idleExitMin: posInt(partial.idleExitMin, DEFAULT_CONTROL.idleExitMin),
    // Copy — the resolved config must never alias DEFAULT_CONTROL's array.
    allowedSenders: [...(partial.allowedSenders ?? DEFAULT_CONTROL.allowedSenders)],
    topics: partial.topics ?? DEFAULT_CONTROL.topics,
    privateTopics: partial.privateTopics ?? DEFAULT_CONTROL.privateTopics,
    gitStateBanner: partial.gitStateBanner ?? DEFAULT_CONTROL.gitStateBanner,
  };
  if (partial.session !== undefined) cfg.session = partial.session;
  if (partial.server !== undefined) cfg.server = partial.server;
  if (partial.machine !== undefined) cfg.machine = partial.machine;
  if (partial.remoteMachines !== undefined) cfg.remoteMachines = partial.remoteMachines;
  return cfg;
}
