// Unit coverage for the PURE half of tg-cli#316: detecting the Codex usage-telemetry Stop hook in
// `config.toml` and planning the removal of the LEGACY `hooks.json` entry once it lives there.
import { expect, test } from 'bun:test';
import { codexUsageHookInConfigToml, planCodexHooksJsonMigration } from '../features/tg-ctl/codex-hooks-migration';

const CMD = 'tg-ctl codex-usage-hook';

// The exact shape rig writes on this machine: an absolute `bun <abs path>/tg-ctl` invocation
// sharing the Stop array with agent-tools' own codex_hook_bridge hook.
const LIVE_CONFIG_TOML = `[hooks]
PreToolUse = [{matcher = "Bash", hooks = [{type = "command", command = "PYTHONPATH=/x/lib python3 -m codex_hook_bridge PreToolUse"}]}]
Stop = [{hooks = [{type = "command", command = "PYTHONPATH=/x/lib python3 -m codex_hook_bridge Stop"}]}, {hooks = [{type = "command", command = "/Users/u/.bun/bin/bun /Users/u/.files/bin/tg-ctl codex-usage-hook"}]}]
# <<< rig managed: codex hook bridge
`;

test('config.toml: the live rig-written absolute invocation counts as installed', () => {
  expect(codexUsageHookInConfigToml(LIVE_CONFIG_TOML, CMD)).toBe(true);
});

test('config.toml: the bare (non-absolute) command in the Stop array counts as installed', () => {
  expect(codexUsageHookInConfigToml(`[hooks]\nStop = [{hooks = [{type = "command", command = "${CMD}"}]}]\n`, CMD)).toBe(true);
});

test('config.toml: a multi-line Stop array is followed to its closing bracket', () => {
  const toml = `[hooks]
Stop = [
  {hooks = [{type = "command", command = "${CMD}"}]},
]
`;
  expect(codexUsageHookInConfigToml(toml, CMD)).toBe(true);
});

test('config.toml: an array-of-tables [[hooks.Stop]] spelling counts as installed', () => {
  const toml = `[[hooks.Stop]]\ntype = "command"\ncommand = "${CMD}"\n`;
  expect(codexUsageHookInConfigToml(toml, CMD)).toBe(true);
});

test('config.toml: a [hooks.Stop] sub-table spelling counts as installed', () => {
  expect(codexUsageHookInConfigToml(`[hooks.Stop]\ncommand = "${CMD}"\n`, CMD)).toBe(true);
});

test('config.toml: a dotted root-level hooks.Stop assignment counts as installed', () => {
  expect(codexUsageHookInConfigToml(`hooks.Stop = [{hooks = [{command = "${CMD}"}]}]\n`, CMD)).toBe(true);
});

test('config.toml: a # inside a single-quoted literal string does not truncate the line', () => {
  expect(codexUsageHookInConfigToml(`[hooks]\nStop = [{hooks = [{command = '${CMD} --tag #1'}]}]\n`, CMD)).toBe(true);
});

test('config.toml: no [hooks] table at all → not installed', () => {
  expect(codexUsageHookInConfigToml('model = "gpt-5"\n[tui]\nnotifications = true\n', CMD)).toBe(false);
});

test('config.toml: a commented-out Stop line does not count as installed', () => {
  expect(codexUsageHookInConfigToml(`[hooks]\n# Stop = [{hooks = [{type = "command", command = "${CMD}"}]}]\n`, CMD)).toBe(false);
});

test('config.toml: the command in a DIFFERENT table is not credited to [hooks]', () => {
  expect(codexUsageHookInConfigToml(`[notify]\ncommand = "${CMD}"\n[hooks]\nPreToolUse = []\n`, CMD)).toBe(false);
});

test('config.toml: only a PreToolUse entry (no Stop) → not installed', () => {
  expect(codexUsageHookInConfigToml(`[hooks]\nPreToolUse = [{hooks = [{type = "command", command = "${CMD}"}]}]\n`, CMD)).toBe(false);
});

test('config.toml: a CRLF file is scanned like an LF one', () => {
  expect(codexUsageHookInConfigToml(`[hooks]\r\nStop = [{hooks = [{command = "${CMD}"}]}]\r\n`, CMD)).toBe(true);
});

test('config.toml: a multi-line NON-Stop array carrying the command is never credited, even beside an empty Stop', () => {
  const toml = `[hooks]\nPreToolUse = [\n  {hooks = [{command = "${CMD}"}]},\n]\nStop = []\n`;
  expect(codexUsageHookInConfigToml(toml, CMD)).toBe(false);
});

test('config.toml: whitespace around the dot in a table header and a single-quoted key are recognized', () => {
  expect(codexUsageHookInConfigToml(`[ hooks . Stop ]\ncommand = "${CMD}"\n`, CMD)).toBe(true);
  expect(codexUsageHookInConfigToml(`[hooks]\n'Stop' = [{hooks = [{command = "${CMD}"}]}]\n`, CMD)).toBe(true);
});

test('config.toml: a [hooks] Stop look-alike inside a multi-line string is not a hook', () => {
  const toml = `instructions = """\nExample:\n[hooks]\nStop = [{hooks = [{command = "${CMD}"}]}]\n"""\n`;
  expect(codexUsageHookInConfigToml(toml, CMD)).toBe(false);
});

test('config.toml: a file that does not parse answers not installed (the safe direction)', () => {
  expect(codexUsageHookInConfigToml(`[hooks]\nStop = [{hooks = [{command = "${CMD}"}]\n`, CMD)).toBe(false);
});

test('config.toml: a Stop hook that only MENTIONS the command outside its `command` field is not ours', () => {
  expect(codexUsageHookInConfigToml(`[hooks]\nStop = [{hooks = [{command = "mine", description = "${CMD}"}]}]\n`, CMD)).toBe(false);
});

test('config.toml: a `command` nested outside the hook entries (e.g. meta.command) is not ours', () => {
  expect(codexUsageHookInConfigToml(`[hooks]\nStop = [{hooks = [{command = "other-hook"}], meta = {command = "${CMD}"}}]\n`, CMD)).toBe(false);
});

test('hooks.json: a FLAT Stop entry of ours (no inner hooks array) is migrated too', () => {
  const raw = JSON.stringify({ hooks: { Stop: [{ type: 'command', command: CMD }, { type: 'command', command: 'mine' }] } });
  expect(planCodexHooksJsonMigration(raw, CMD)).toEqual({ action: 'rewrite', json: `${JSON.stringify({ hooks: { Stop: [{ type: 'command', command: 'mine' }] } }, null, 2)}\n` });
});

// --- hooks.json migration plan ------------------------------------------------------------------

// The real file Alex had to delete by hand (~/.codex/hooks.json.pre-308-migration.bak).
const LEGACY_HOOKS_JSON = JSON.stringify(
  { hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD, timeout: 30 }] }] } },
  null,
  2,
);

test('hooks.json: our lone Stop entry → the whole file is dropped', () => {
  expect(planCodexHooksJsonMigration(LEGACY_HOOKS_JSON, CMD)).toEqual({ action: 'delete' });
});

test('hooks.json: a non-object Stop group is kept verbatim while ours is removed', () => {
  const raw = JSON.stringify({ hooks: { Stop: [null, { hooks: [{ type: 'command', command: CMD }] }] } });
  expect(planCodexHooksJsonMigration(raw, CMD)).toEqual({ action: 'rewrite', json: `${JSON.stringify({ hooks: { Stop: [null] } }, null, 2)}\n` });
});

test('a COMPOUND command that runs ours anywhere in a shell chain is not removed (its other half would be lost)', () => {
  for (const compound of [`${CMD} && my-archiver.sh`, `my-archiver.sh && ${CMD}`, `notify.sh; ${CMD}`, `foo | ${CMD}`, `x=$(date) ${CMD}`, `notify.sh\n${CMD}`]) {
    expect(planCodexHooksJsonMigration(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: compound }] }] } }), CMD)).toEqual({ action: 'none' });
    expect(codexUsageHookInConfigToml(`[hooks]\nStop = [{hooks = [{command = ${JSON.stringify(compound)}}]}]\n`, CMD)).toBe(false);
  }
});

test('a flat-looking group of ours that ALSO holds inner hooks is left alone and not credited, in both files', () => {
  const raw = JSON.stringify({ hooks: { Stop: [{ type: 'command', command: CMD, hooks: [{ type: 'command', command: 'user-hook' }] }] } });
  expect(planCodexHooksJsonMigration(raw, CMD)).toEqual({ action: 'none' });
  expect(codexUsageHookInConfigToml(`[[hooks.Stop]]\ncommand = "${CMD}"\nhooks = [{command = "user-hook"}]\n`, CMD)).toBe(false);
});

test('a command that merely CONTAINS ours as a prefix is someone else’s hook, in both files', () => {
  const other = `${CMD}-canary`;
  expect(codexUsageHookInConfigToml(`[hooks]\nStop = [{hooks = [{command = "${other}"}]}]\n`, CMD)).toBe(false);
  expect(planCodexHooksJsonMigration(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: other }] }] } }), CMD)).toEqual({ action: 'none' });
});

test('hooks.json: an absolute-path invocation of our command is recognized too', () => {
  const raw = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `/Users/u/.bun/bin/bun /Users/u/.files/bin/${CMD}` }] }] } });
  expect(planCodexHooksJsonMigration(raw, CMD)).toEqual({ action: 'delete' });
});

test('hooks.json: an unrelated Stop hook survives — the file is rewritten, not deleted', () => {
  const raw = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }] }, { hooks: [{ type: 'command', command: 'my-own-hook' }] }] },
  });
  const plan = planCodexHooksJsonMigration(raw, CMD);
  expect(plan.action).toBe('rewrite');
  const next = JSON.parse((plan as { json: string }).json);
  expect(next).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] } });
});

test('hooks.json: a sibling hook inside OUR group survives, the group is kept', () => {
  const raw = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }, { type: 'command', command: 'other' }] }] } });
  const plan = planCodexHooksJsonMigration(raw, CMD);
  expect(plan.action).toBe('rewrite');
  expect(JSON.parse((plan as { json: string }).json)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } });
});

test('hooks.json: an unrelated EVENT survives — Stop key removed, hooks table kept', () => {
  const raw = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] },
  });
  const plan = planCodexHooksJsonMigration(raw, CMD);
  expect(plan.action).toBe('rewrite');
  expect(JSON.parse((plan as { json: string }).json)).toEqual({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] },
  });
});

test('hooks.json: unrelated TOP-LEVEL keys survive — hooks key removed, file kept', () => {
  const raw = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }] }] }, other: true });
  const plan = planCodexHooksJsonMigration(raw, CMD);
  expect(plan.action).toBe('rewrite');
  expect(JSON.parse((plan as { json: string }).json)).toEqual({ other: true });
});

test('hooks.json: idempotent — a file with nothing of ours yields none', () => {
  expect(planCodexHooksJsonMigration(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }), CMD)).toEqual({
    action: 'none',
  });
});

test('hooks.json: missing / empty / unparseable / non-object files are left alone', () => {
  expect(planCodexHooksJsonMigration(null, CMD)).toEqual({ action: 'none' });
  expect(planCodexHooksJsonMigration('   \n', CMD)).toEqual({ action: 'none' });
  expect(planCodexHooksJsonMigration('{ not json', CMD)).toEqual({ action: 'none' });
  expect(planCodexHooksJsonMigration('[]', CMD)).toEqual({ action: 'none' });
  expect(planCodexHooksJsonMigration('{"hooks": "nope"}', CMD)).toEqual({ action: 'none' });
  expect(planCodexHooksJsonMigration('{"hooks": {"Stop": "nope"}}', CMD)).toEqual({ action: 'none' });
});
