import { expect, test } from 'bun:test';
import { DEFAULT_FEATURES, parseFeatureConfig } from '../features/auto-attach/feature-flags';
import { configSchemaText, generateConfigSchema, renderConfigHelp, type ConfigSettingSchema } from '../features/config/schema';
import { parseControlConfig, resolveControlConfig } from '../features/tg-ctl/config';
import { DEFAULT_CONTROL, type ControlConfig } from '../features/tg-ctl/types';
import { DEFAULT_VOICE, parseVoiceConfig, resolveVoiceConfig, type VoiceConfig } from '../features/tg-ctl/voice';

const controlKeys = {
  enabled: 'enabled', transport: 'transport', session: 'session', injectWrap: 'inject_wrap',
  stalenessSec: 'staleness_sec', idleExitMin: 'idle_exit_min', allowedSenders: 'allowed_senders',
  topics: 'topics', privateTopics: 'private_topics', gitStateBanner: 'git_state_banner',
  server: 'server', machine: 'machine', remoteMachines: 'remote_machines',
} satisfies Record<keyof ControlConfig, string>;

const voiceKeys = {
  enabled: 'enabled', runner: 'runner', binPath: 'bin_path', modelPath: 'model_path',
  language: 'language', threads: 'threads',
} satisfies Record<keyof VoiceConfig, string>;

test('schema is deterministic JSON with a trailing newline and no required settings', () => {
  const schema = generateConfigSchema();
  expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(schema.type).toBe('object');
  expect(schema).not.toHaveProperty('required');
  expect(configSchemaText()).toBe(JSON.stringify(schema, null, 2) + '\n');
  expect(configSchemaText()).toBe(configSchemaText());
  expect(JSON.parse(configSchemaText())).toEqual(schema);
});

test('schema has exactly the known sections and rejects unknown editor keys', () => {
  const schema = generateConfigSchema();
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual(['control', 'features', 'laya', 'voice']);
  expect(Object.values(schema.properties).reduce((n, section) => n + Object.keys(section.properties).length, 0)).toBe(38);
  expect(schema.properties.features.properties).not.toHaveProperty('auto-attach');
  expect(schema.properties.features.properties).not.toHaveProperty('recursive-attach');
});

test('the runtime default objects have no keys the schema tables miss', () => {
  // Bun transpiles without a typecheck: compare real defaults, not just two
  // hand-maintained key lists. These are the only fields without defaults.
  expect(Object.keys(controlKeys).sort()).toEqual([...new Set([...Object.keys(DEFAULT_CONTROL), 'session', 'server', 'machine', 'remoteMachines'])].sort());
  expect(Object.keys(voiceKeys).sort()).toEqual([...new Set([...Object.keys(DEFAULT_VOICE), 'threads'])].sort());
});

const EXPECTED_KEYS = {
  control: Object.values(controlKeys),
  voice: Object.values(voiceKeys),
  features: Object.keys(DEFAULT_FEATURES),
  laya: ['enabled', 'autostart', 'required', 'cold_timeout_sec', 'warm_timeout_ms', 'task_bin', 'socket'],
};

test.each(['control', 'voice', 'features', 'laya'] as const)('section %s is a closed object with exactly its runtime keys', (section) => {
  const definition = generateConfigSchema().properties[section];
  expect(definition.type).toBe('object');
  expect(definition.additionalProperties).toBe(false);
  expect(definition).not.toHaveProperty('required');
  expect(Object.keys(definition.properties).sort()).toEqual(EXPECTED_KEYS[section].sort());
});

test('laya settings carry the documented defaults and no default for the unset task_bin', () => {
  const { laya } = generateConfigSchema().properties;
  expect(Object.fromEntries(Object.entries(laya.properties).map(([key, setting]) => [key, setting.default]))).toEqual({
    enabled: true, autostart: true, required: false, cold_timeout_sec: 75, warm_timeout_ms: 3000, task_bin: undefined, socket: undefined,
  });
  expect(laya.properties.cold_timeout_sec.minimum).toBe(1);
  expect(laya.properties.warm_timeout_ms.minimum).toBe(1);
  expect(renderConfigHelp()).toContain('task classify-server start');
});

test('schema defaults follow runtime defaults, including opt-in voice and optional fields', () => {
  const { control, voice, features } = generateConfigSchema().properties;
  for (const [runtimeKey, yamlKey] of Object.entries(controlKeys)) {
    const value = DEFAULT_CONTROL[runtimeKey as keyof ControlConfig];
    if (value === undefined) expect(control.properties[yamlKey]).not.toHaveProperty('default');
    else expect(control.properties[yamlKey].default).toEqual(Array.isArray(value) ? value.join(', ') : value);
  }
  for (const [runtimeKey, yamlKey] of Object.entries(voiceKeys)) {
    const value = DEFAULT_VOICE[runtimeKey as keyof VoiceConfig];
    if (value === undefined) expect(voice.properties[yamlKey]).not.toHaveProperty('default');
    else expect(voice.properties[yamlKey].default).toEqual(value);
  }
  for (const [key, value] of Object.entries(DEFAULT_FEATURES)) {
    expect(features.properties[key].default).toBe(value);
    expect(features.properties[key].type).toBe('boolean');
  }
  expect(control.properties.enabled.default).toBe(true);
  expect(voice.properties.enabled.default).toBe(false);
  expect(voice.properties.runner.default).toBe('whisper.cpp');
});

test('schema gives canonical booleans, positive integer ranges, and the supported enums', () => {
  const { control, voice } = generateConfigSchema().properties;
  for (const field of [control.properties.enabled, control.properties.topics, control.properties.private_topics,
    control.properties.git_state_banner, voice.properties.enabled]) expect(field.type).toBe('boolean');
  for (const field of [control.properties.staleness_sec, control.properties.idle_exit_min, voice.properties.threads]) {
    expect(field.type).toBe('integer');
    expect(field.minimum).toBe(1);
  }
  expect(control.properties.transport.enum).toEqual(['auto', 'tmux', 'channel']);
  expect(voice.properties.runner.enum).toEqual(['whisper.cpp', 'faster-whisper']);
});

test('allowed_senders describes the actual CSV scalar, including the single-number form', () => {
  const field = generateConfigSchema().properties.control.properties.allowed_senders;
  expect(field.type).toEqual(['string', 'integer']);
  expect(field.minimum).toBe(0);
  const pattern = new RegExp(field.pattern!);
  for (const value of ['', '123', '123, 456', ' 123,456 ']) expect(pattern.test(value)).toBe(true);
  for (const value of ['[123, 456]', '123, abc', '-1', '1.5']) expect(pattern.test(value)).toBe(false);
  expect(parseControlConfig('control:\n  allowed_senders: 123, 456\n').allowedSenders).toEqual([123, 456]);
  expect(parseControlConfig('control:\n  allowed_senders: 123\n').allowedSenders).toEqual([123]);
});

test('every schema default can be written as a scalar and parsed back to the runtime default', () => {
  const schema = generateConfigSchema();
  const yaml = Object.entries(schema.properties).map(([section, definition]) => [
    `${section}:`,
    ...Object.entries(definition.properties).filter(([, setting]) => 'default' in setting)
      .map(([key, setting]) => `  ${key}: ${JSON.stringify(setting.default)}`),
  ].join('\n')).join('\n');
  expect(resolveControlConfig(parseControlConfig(yaml))).toEqual(DEFAULT_CONTROL);
  expect(resolveVoiceConfig(parseVoiceConfig(yaml))).toEqual(DEFAULT_VOICE);
  expect(parseFeatureConfig(yaml)).toEqual(DEFAULT_FEATURES);
});

function expectPortableExample(setting: ConfigSettingSchema, example: string | number | boolean): void {
  const types = Array.isArray(setting.type) ? setting.type : [setting.type];
  expect(types).toContain(typeof example === 'number' && Number.isInteger(example) ? 'integer' : typeof example);
  if (setting.enum) expect(setting.enum).toContain(example);
  if (typeof example === 'number' && setting.minimum !== undefined) expect(example).toBeGreaterThanOrEqual(setting.minimum);
  if (typeof example !== 'string') return;
  if (setting.pattern) expect(new RegExp(setting.pattern).test(example)).toBe(true);
  // Shipped examples must not capture a developer's home or workspace.
  expect(example).not.toMatch(/\/(?:home|Users)\/[^/\s]+|[A-Z]:\\Users\\|\/workspace\/scratch\//i);
  expect(example).not.toMatch(/TG_BOT_TOKEN\s*=|\d{6,}:[A-Za-z0-9_-]{20,}/);
}

test('every setting has portable examples that satisfy its schema constraints', () => {
  const schema = generateConfigSchema();
  for (const setting of Object.values(schema.properties).flatMap((section) => Object.values(section.properties))) {
    expect(Array.isArray(setting.examples)).toBe(true);
    expect(setting.examples.length).toBeGreaterThan(0);
    for (const example of setting.examples) expectPortableExample(setting, example);
  }
  expect(schema.properties.control.properties.session.examples).toContain('agents');
  expect(schema.properties.voice.properties.bin_path.examples.some((value) => typeof value === 'string' && value.length > 0)).toBe(true);
  expect(schema.properties.voice.properties.model_path.examples.some((value) => typeof value === 'string' && value.length > 0)).toBe(true);
});

test('every example is honored when passed through the actual runtime readers', () => {
  const { control, voice, features } = generateConfigSchema().properties;
  for (const [runtimeKey, yamlKey] of Object.entries(controlKeys)) {
    for (const example of control.properties[yamlKey].examples) {
      const yaml = `control:\n  ${yamlKey}: ${JSON.stringify(example)}\n`;
      const parsed = parseControlConfig(yaml)[runtimeKey as keyof ControlConfig];
      const expected = runtimeKey === 'allowedSenders'
        ? String(example).split(',').map((value) => value.trim()).filter(Boolean).map(Number)
        : example;
      expect(parsed).toEqual(expected);
    }
  }
  for (const [runtimeKey, yamlKey] of Object.entries(voiceKeys)) {
    for (const example of voice.properties[yamlKey].examples) {
      const yaml = `voice:\n  ${yamlKey}: ${JSON.stringify(example)}\n`;
      expect(parseVoiceConfig(yaml)[runtimeKey as keyof VoiceConfig]).toEqual(example);
    }
  }
  for (const [key, setting] of Object.entries(features.properties)) {
    for (const example of setting.examples) {
      expect(parseFeatureConfig(`features:\n  ${key}: ${JSON.stringify(example)}\n`)[key]).toBe(example);
    }
  }
});

test('generated help lists every schema setting, its type, default, and description', () => {
  const schema = generateConfigSchema();
  const help = renderConfigHelp('/tmp/tg-profile');
  for (const [section, definition] of Object.entries(schema.properties)) {
    for (const [key, setting] of Object.entries(definition.properties)) {
      expect(help).toContain(`${section}.${key}`);
      expect(help).toContain(setting.description);
      for (const example of setting.examples) {
        expect(help).toContain(`Example: ${key}: ${JSON.stringify(example)}`);
      }
    }
  }
  expect(help).toContain('/tmp/tg-profile/config.yaml');
  expect(help).toContain('/tmp/tg-profile/config.schema.json');
  expect(help).toContain('Default:');
  expect(help).toContain('physical core count');
  expect(help).toContain('auto-discover');
});

test('help includes a copyable example config without enabling voice or adding senders', () => {
  const help = renderConfigHelp();
  const match = help.match(/Example config\.yaml \(credentials stay in \.env\):\n([^]+?)\n\n/);
  expect(match).not.toBeNull();
  const yaml = match![1];
  expect(yaml).toContain('# yaml-language-server: $schema=./config.schema.json');
  expect(parseControlConfig(yaml)).toEqual({ enabled: true, idleExitMin: 15 });
  expect(parseVoiceConfig(yaml)).toEqual({ enabled: false });
  expect(parseFeatureConfig(yaml)).toEqual({ 'autolink-msgrefs': true });
  expect(yaml).not.toMatch(/TG_BOT_TOKEN|TG_CHAT_ID|allowed_senders|bin_path|model_path/);
});

test('help explains the narrow enabled switch, legacy options, credentials, and precedence', () => {
  const help = renderConfigHelp();
  expect(help).toContain('~/.config/tg-cli/config.yaml');
  expect(help).toContain('lazy autostart');
  expect(help).toContain('tg-ctl run');
  expect(help).toContain('tg-ctl start');
  expect(help).toContain('tg-ctl disable');
  expect(help).toContain('buttons');
  expect(help).toContain('registrations');
  expect(help).toContain('reserved');
  expect(help).toContain('does not drop inbound messages by age');
  expect(help).toContain('TG_BOT_TOKEN');
  expect(help).toContain('TG_CHAT_ID');
  expect(help).toContain('.env');
  expect(help).toContain('TG_CTL_CONFIG_DIR');
  expect(help).toContain('--feature');
  expect(help).toContain('--no-feature');
});

test('help distinguishes canonical editor syntax from the existing permissive readers', () => {
  const help = renderConfigHelp();
  expect(help).toContain('yes/no');
  expect(help).toContain('on/off');
  expect(help).toContain('1/0');
  expect(help).toContain('quoted booleans');
  expect(help).toContain('voice.enabled');
  expect(help).toContain('unknown');
  expect(help).toContain('one-level');
  expect(help).toContain('YAML arrays');
  expect(parseControlConfig('control:\n  enabled: "false"\n')).toEqual({});
  expect(parseVoiceConfig('voice:\n  enabled: "false"\n')).toEqual({ enabled: false });
});
