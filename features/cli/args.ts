// --- Arg parsing (pure) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 0c, docs/specs/
// tg-decomposition.md). Pure: captures no main() state. The only disk access is
// `resolveExistingFile`, which checks an explicit --photo/--file value — the
// message text is NEVER resolved into file paths (tg-cli#648). The entrypoint
// imports `parseArgs` + the `Format` type from here.
//
// This module is the single public surface; the implementation is split by concern:
//   args-types.ts  result/option types      args-paths.ts   path helpers
//   args-gates.ts  per-tag TAG_GATES        args-flags.ts   per-flag handlers + loop
//   args-finish.ts line-specs, gates, empty check, `send` assembly
import { finishParse } from './args-finish';
import { parseFlagLoop } from './args-flags';
import type { ParseOptions, ParseResult } from './args-types';

export { escalationGateEnforced } from './args-gates';
export { expandHome, isImagePath, resolveExistingFile } from './args-paths';
export type { Format, Item, ItemLineSpec, ParseOptions, ParseResult } from './args-types';

// Info-only flags in precedence order: the first entry present anywhere on the line wins.
const INFO_FLAGS: ReadonlyArray<readonly [string, ParseResult]> = [
  ['--ls-emoji-helpers', { action: 'lsEmojiHelpers' }],
  ['--detect-model', { action: 'detectModel' }],
  ['--detect-agent', { action: 'detectAgent' }],
  ['--session-topic', { action: 'sessionTopic' }],
  ['--session-id', { action: 'sessionId' }],
  ['--format-help', { action: 'formatHelp' }],
];

function findEarlyAction(args: string[]): ParseResult | null {
  // 1. Help / version win anywhere, before the empty check.
  if (args.some((a) => a === '-h' || a === '--help')) return { action: 'help' };
  if (args.some((a) => a === '-v' || a === '--version')) return { action: 'version' };
  // 2. Info-only flags win next, anywhere on the line.
  for (const [flag, result] of INFO_FLAGS) {
    if (args.includes(flag)) return { ...result };
  }
  return null;
}

/**
 * Parse argv (already sliced past node/script) into an action. Never throws and
 * never calls process.exit: the caller decides what to do with the result.
 *
 * Precedence (the reconciliation point for "unknown dashed → error"):
 *   1. -h/--help and -v/--version win anywhere, before everything else.
 *   2. Info-only flags --ls-emoji-helpers / --detect-model / --detect-agent / --session-topic / --session-id win next.
 *   3. Real flags are matched: --format (with value validation), --photo,
 *      --file (each consuming a path value).
 *   4. ONLY a dashed token that matched none of the above is "unknown" → error.
 * This guarantees every flag main supports is recognized before the
 * unknown-dashed guard can fire, so none of them regress to an error.
 */
export function parseArgs(
  args: string[],
  cwd: string,
  home: string,
  { attachDenylist = true, msgrefAutolink = true, ticketAutolink = true, bodyText }: ParseOptions = {},
): ParseResult {
  const early = findEarlyAction(args);
  if (early) return early;

  const state = parseFlagLoop(args, { cwd, home, attachDenylist, msgrefAutolink, ticketAutolink });
  if ('action' in state) return state;
  return finishParse(state, bodyText, cwd, home);
}
