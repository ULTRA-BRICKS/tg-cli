// Feature-toggle system for tg-cli.
//
// Resolution order (lowest → highest precedence):
//   1. DEFAULT_FEATURES (auto-attach ON by default)
//   2. ~/.config/tg-cli/config.yaml  → features.<name>
//   3. CLI flags --feature <name> (force ON) / --no-feature <name> (force OFF)
//
// Everything here is PURE — the YAML file I/O lives in the tg entrypoint, which
// hands the already-read file contents to parseFeatureConfig. This keeps the
// resolution logic trivially unit-testable with no disk access.

export type FeatureMap = Record<string, boolean>;

// Default feature state. auto-attach is ON by default per spec §North star;
// autolink-tasks per docs/specs/autolink-tasks.md §North star; autolink-prs
// resolves GitHub #N refs (issues into the tickets block, PRs in their own
// block) per docs/specs/autolink-prs.md §North star; md-as-pdf converts attached
// markdown to PDF (emoji/Cyrillic-safe preview); attach-denylist blocks
// secret-looking files (.env, keys, credentials); recursive-attach finds
// mentioned files deeper than cwd (auto-attach spec §Recursive resolution).
export const DEFAULT_FEATURES: FeatureMap = {
  'auto-attach': true,
  'autolink-tasks': true,
  'autolink-prs': true,
  // autolink-msgrefs links `tg#<id>` inbound-message references (the convention
  // the inbound inject wrap renders) — distinct from a GitHub `#<id>`. Pure
  // text + an optional t.me deep link; no CLI spawn, so default-ON is free.
  'autolink-msgrefs': true,
  'md-as-pdf': true,
  // code-as-pdf renders attached code/config files (.ts, .json, .yaml, …) to a
  // mobile, syntax-highlighted PDF; by default ONLY the PDF is sent (the raw
  // file is dropped — useless on iOS). `--with-original`/`--no-pdf` adjust.
  'code-as-pdf': true,
  'attach-denylist': true,
  'recursive-attach': true,
  // Enforces the tg-cli#208 message-fragmentation cap. `--no-feature
  // flood-cap` or `features.flood-cap: false` in config.yaml opts out.
  'flood-cap': true,
  // cjk-guard rejects two "a garbled token slipped in" shapes: (1) an isolated
  // CJK/ideographic codepoint stuck mid-word into otherwise Latin/Cyrillic text
  // (the "hieroglyph in a normal word" bug); (2) a homoglyph/mojibake garbage
  // word that mixes Cyrillic with a foreign alphabet in ONE token (e.g.
  // "почčesна"). A genuinely CJK message and separate Cyrillic/Latin WORDS pass.
  // `--no-feature cjk-guard` disables both. See features/cli/cjk-guard.ts and
  // features/cli/mixed-script-guard.ts.
  'cjk-guard': true,
  // pre-send-photo hooks (agents-hooks/v1). ON by default, but it is a TRUE
  // no-op unless ~/.agents/hooks/tg/ exists (one `stat`), so default-ON costs
  // nothing on machines with no descriptors. `--no-feature hooks` or
  // AGENTS_HOOKS=0 hard-bypasses.
  hooks: true,
};

// A deliberately tiny YAML reader. We only support the exact shape the spec
// mandates — a top-level `features:` block of `  <name>: <bool>` lines — so a
// hand-rolled 20-line parser beats pulling in a yaml dependency (package.json
// intentionally has only bun-types). Anything outside that shape is ignored.
const TRUE_TOKENS = new Set(['true', 'yes', 'on', '1']);
const FALSE_TOKENS = new Set(['false', 'no', 'off', '0']);

export function parseFeatureConfig(yaml: string): FeatureMap {
  const out: FeatureMap = {};
  let inFeatures = false;
  for (const rawLine of yaml.split('\n')) {
    // Strip trailing comments (only when clearly a comment, not inside a value).
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      // A top-level key. We only care about `features:`.
      inFeatures = line.trim().replace(/:.*$/, '') === 'features';
      continue;
    }
    if (!inFeatures) continue;

    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const name = trimmed
      .slice(0, colon)
      .trim()
      .replace(/^["']|["']$/g, '');
    const value = trimmed
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (!name) continue;
    if (TRUE_TOKENS.has(value)) out[name] = true;
    else if (FALSE_TOKENS.has(value)) out[name] = false;
    // unrecognized value → ignore (don't guess)
  }
  return out;
}

export interface FeatureOverrides {
  enable: string[];
  disable: string[];
}

// Merge the three layers into a final FeatureMap.
export function resolveFeatures(config: FeatureMap, overrides: FeatureOverrides): FeatureMap {
  const merged: FeatureMap = { ...DEFAULT_FEATURES, ...config };
  for (const name of overrides.enable) merged[name] = true;
  for (const name of overrides.disable) merged[name] = false;
  return merged;
}

export interface ApplyFlagsResult {
  enable: string[];
  disable: string[];
  rest: string[];
  error?: string;
}

// Pull --feature <name> / --no-feature <name> out of argv. Each consumes a
// value, so the unknown-flag guard in parseArgs never sees them. The remaining
// args are returned for the normal parser. A missing value is an error.
export function applyFeatureFlags(args: string[]): ApplyFlagsResult {
  const enable: string[] = [];
  const disable: string[] = [];
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--feature' || arg === '--no-feature') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        return { enable, disable, rest, error: `${arg} requires a feature name` };
      }
      if (arg === '--feature') enable.push(value);
      else disable.push(value);
      i += 2;
      continue;
    }
    rest.push(arg);
    i += 1;
  }
  return { enable, disable, rest };
}
