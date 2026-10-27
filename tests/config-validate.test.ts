import { expect, test } from 'bun:test';
import { generateConfigSchema } from '../features/config/schema';
import { validateConfigText } from '../features/config/validate';
import { parseControlConfig } from '../features/tg-ctl/config';
import { parseVoiceConfig } from '../features/tg-ctl/voice';
import { parseFeatureConfig } from '../features/auto-attach/feature-flags';

const messages = (raw: string, severity: 'error' | 'warning' = 'error') =>
  validateConfigText(raw).filter((d) => d.severity === severity).map((d) => `${d.line}:${d.message}`);

const USER_SHAPE = `# yaml-language-server: $schema=./config.schema.json
control:
  private_topics: true
  enabled: false
voice:
  enabled: true
  runner: faster-whisper
  bin_path: "/home/u/.venv/bin/python"
  model_path: "/home/u/models/large-v3-turbo"
  language: auto
`;

test('accepts a missing, blank, comment-only, and the current real-world configuration', () => {
  for (const raw of ['', '\n\n', '# only a comment\n', '\uFEFF---\r\ncontrol:\r\n  topics: true\r\n', USER_SHAPE]) {
    expect(validateConfigText(raw)).toEqual([]);
  }
});

test('accepts every canonical setting with its documented example', () => {
  const raw = [
    'control:', '  enabled: true', '  transport: tmux', '  session: agents', '  inject_wrap: "[{name} {id}] {msg}"',
    '  staleness_sec: 600', '  idle_exit_min: 15', '  allowed_senders: "1, 2"', '  topics: false',
    '  private_topics: true', '  git_state_banner: false',
    'voice:', '  enabled: true', '  runner: whisper.cpp', '  bin_path: /x/whisper-cli', '  model_path: /x/m.bin',
    '  language: en', '  threads: 4',
    'features:', '  flood-cap: false', '  "hooks": true',
  ].join('\n');
  expect(validateConfigText(raw)).toEqual([]);
  expect(parseControlConfig(raw).allowedSenders).toEqual([1, 2]);
});

test('reports unknown top-level, section and feature keys with their line', () => {
  const raw = 'control:\n  enabeld: false\nvoice:\n  volume: 3\nfeatures:\n  nope: true\nextra: 1\n';
  expect(messages(raw)).toEqual([
    '2:control.enabeld is not a known setting',
    '4:voice.volume is not a known setting',
    '6:features.nope is not a known feature',
    '7:extra is not a known top-level key (expected control, voice or features)',
  ]);
});

test('rejects invalid types, enum values and ranges that the runtime would silently ignore or heal', () => {
  const raw = [
    'control:', '  enabled: maybe', '  transport: carrier-pigeon', '  staleness_sec: 0', '  idle_exit_min: 1.5',
    '  allowed_senders: [1, 2]', '  topics: 2',
    'voice:', '  runner: vosk', '  threads: -3', '  enabled: tru',
    'features:', '  flood-cap: sometimes',
  ].join('\n');
  expect(messages(raw)).toEqual([
    '2:control.enabled must be true or false (got "maybe")',
    '3:control.transport must be one of auto, tmux, channel (got "carrier-pigeon")',
    '4:control.staleness_sec must be at least 1 (got 0)',
    '5:control.idle_exit_min must be an integer (got "1.5")',
    '6:control.allowed_senders must be comma-separated user IDs or a single integer (got "[1, 2]")',
    '7:control.topics must be true or false (got "2")',
    '9:voice.runner must be one of whisper.cpp, faster-whisper (got "vosk")',
    '10:voice.threads must be at least 1 (got -3)',
    '11:voice.enabled must be true or false (got "tru")',
    '13:features.flood-cap must be true or false (got "sometimes")',
  ]);
});

test('legacy forms the runtime accepts are warnings, not errors', () => {
  const raw = 'control:\n  enabled: no\n  topics: 1\nvoice:\n  enabled: "false"\n  threads: "4"\nfeatures:\n  hooks: off\n';
  expect(messages(raw)).toEqual([]);
  expect(messages(raw, 'warning')).toEqual([
    '2:control.enabled: "no" is accepted by the runtime; the editor schema expects true or false',
    '3:control.topics: "1" is accepted by the runtime; the editor schema expects true or false',
    '5:voice.enabled: "false" is accepted by the runtime; the editor schema expects true or false',
    '6:voice.threads: "4" is accepted by the runtime; the editor schema expects an unquoted integer',
    '8:features.hooks: "off" is accepted by the runtime; the editor schema expects true or false',
  ]);
});

test('quoted values the runtime ignores are errors', () => {
  const raw = 'control:\n  enabled: "false"\n  idle_exit_min: "15"\nfeatures:\n  hooks: "false"\n';
  expect(messages(raw)).toEqual([
    '2:control.enabled must be true or false (got "\\"false\\"")',
    '3:control.idle_exit_min must be an integer (got "\\"15\\"")',
    '5:features.hooks must be true or false (got "\\"false\\"")',
  ]);
  // The runtime really does ignore them, so the diagnostics are not stricter than reality.
  expect(parseControlConfig(raw)).toEqual({});
  expect(parseFeatureConfig(raw)).toEqual({});
});

test('rejects YAML the simple runtime readers silently skip', () => {
  const cases: Array<[string, string]> = [
    ['control: {enabled: false}\n', '1:control must be a block of indented key: value lines; the runtime ignores an inline value'],
    ['control:\n  - enabled\n', '2:control has a line that is not "key: value"; the runtime ignores it'],
    ['control:\n  enabled:false\n', '2:control.enabled needs a space after the colon; YAML reads "enabled:false" as one string'],
    ['control:\n  enabled:\n    nested: 1\n', '2:control.enabled has an empty value; the runtime ignores it (nested mappings are unsupported)'],
    ['control:\n  enabled false\n', '2:control has a line that is not "key: value"; the runtime ignores it'],
    ['"control":\n  enabled: false\n', '1:"\\"control\\"" is not a known top-level key (expected control, voice or features)'],
    ['control :\n  enabled: false\n', '1:"control " is not a known top-level key (expected control, voice or features)'],
    ['control:\n  enabled: true\n    topics: true\n', '3:control: indentation differs from the first entry; the runtime reads each indented line as a one-level key'],
    ['control:\n\tenabled: false\n', '2:tab indentation is not valid YAML'],
    ['control:\n  enabled: true\n  enabled: false\n', '3:control.enabled is duplicated (first on line 2)'],
    ['control:\n  topics: true\ncontrol:\n  topics: false\n', '3:control is duplicated (first on line 1)'],
    ['control:\n  session: "agents\n', '2:control.session has an unbalanced quote'],
  ];
  for (const [raw, expected] of cases) expect(messages(raw)).toContain(expected);
});

test('rejects non-mapping documents', () => {
  expect(messages('- a\n- b\n')).toEqual(['1:top level must be a mapping of control, voice and features blocks']);
  expect(messages('just words\n')).toEqual(['1:top level must be a mapping of control, voice and features blocks']);
  expect(messages('---\n  enabled: true\n')).toEqual(['2:top level must be a mapping of control, voice and features blocks']);
  expect(messages('control: [broken\n')).toEqual([
    '1:control must be a block of indented key: value lines; the runtime ignores an inline value',
  ]);
});

test('treats trailing comments like the runtime does', () => {
  const raw = 'control:   # block comment\n  enabled: false # off\n  session: "a # b"\n';
  expect(messages(raw)).toContain('3:control.session has an unbalanced quote');
  expect(parseControlConfig(raw).enabled).toBe(false);
});

test('valid shapes agree with the runtime parsers', () => {
  expect(parseControlConfig(USER_SHAPE)).toEqual({ privateTopics: true, enabled: false });
  expect(parseVoiceConfig(USER_SHAPE).runner).toBe('faster-whisper');
});

test('inherited object properties are not settings', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    expect(messages(`control:\n  ${name}: false\n`)).toEqual([`2:control.${name} is not a known setting`]);
    expect(messages(`features:\n  ${name}: true\n`)).toEqual([`2:features.${name} is not a known feature`]);
    expect(messages(`${name}:\n  enabled: false\n`)).toEqual([
      `1:${name} is not a known top-level key (expected control, voice or features)`,
    ]);
  }
});

test('a byte-order mark directly before a key is an error because the runtime reads that line as indented', () => {
  const raw = '\uFEFFcontrol:\n  enabled: false\n';
  expect(parseControlConfig(raw)).toEqual({});
  expect(messages(raw)).toEqual([
    '1:a byte-order mark directly before a key makes the runtime read the line as indented and ignore it; start the file with a comment or remove the mark',
  ]);
  expect(messages('\uFEFF# comment\ncontrol:\n  enabled: false\n')).toEqual([]);
  expect(parseControlConfig('\uFEFF# comment\ncontrol:\n  enabled: false\n')).toEqual({ enabled: false });
});

test('integers that overflow to Infinity are rejected like the runtime heals them', () => {
  const huge = '9'.repeat(400);
  expect(messages(`control:\n  idle_exit_min: ${huge}\n`)).toEqual(['2:control.idle_exit_min is too large to be a valid integer']);
  expect(messages(`voice:\n  threads: ${huge}\n`)).toEqual(['2:voice.threads is too large to be a valid integer']);
  expect(messages('control:\n  idle_exit_min: 99999\n')).toEqual([]);
});

test('unquoted YAML collections and indicators are not strings', () => {
  const cases: Array<[string, string]> = [
    ['voice:\n  model_path: [small, base]\n', '2:voice.model_path must be a string; quote it so YAML does not read "[small, base]" as another kind of value'],
    ['control:\n  session: {name: agents}\n', '2:control.session must be a string; quote it so YAML does not read "{name: agents}" as another kind of value'],
    ['voice:\n  language: *en\n', '2:voice.language must be a string; quote it so YAML does not read "*en" as another kind of value'],
    ['control:\n  session: |\n', '2:control.session must be a string; quote it so YAML does not read "|" as another kind of value'],
  ];
  for (const [raw, expected] of cases) expect(messages(raw)).toEqual([expected]);
  // Quoted, the same text is a plain string (and is how the default inject_wrap is written).
  expect(messages('control:\n  inject_wrap: "[TG from {name} {id}] {msg}"\n  session: "[x]"\n')).toEqual([]);
  expect(messages('voice:\n  model_path: ./models/[small]\n')).toEqual([]);
});

test('voice.threads numeric forms the runtime accepts are warnings', () => {
  for (const [value, accepted] of [['+4', 4], ['0x10', 16], ['4.0', 4], ['1e1', 10]] as const) {
    const raw = `voice:\n  threads: ${value}\n`;
    expect(parseVoiceConfig(raw).threads).toBe(accepted);
    expect(messages(raw)).toEqual([]);
    expect(messages(raw, 'warning')).toEqual([
      `2:voice.threads: ${JSON.stringify(value)} is accepted by the runtime; the editor schema expects a plain decimal integer`,
    ]);
  }
  for (const value of ['0', '-2', '1.5', 'four', '0x0']) {
    const raw = `voice:\n  threads: ${value}\n`;
    expect(parseVoiceConfig(raw).threads).toBeUndefined();
    expect(messages(raw)).toHaveLength(1);
  }
  // control integers use a strict decimal reader, so these stay errors there.
  expect(messages('control:\n  idle_exit_min: +4\n')).toHaveLength(1);
  expect(parseControlConfig('control:\n  idle_exit_min: +4\n')).toEqual({});
});

test('unquoted YAML booleans, numbers and null are not strings', () => {
  const kinds = ['false', 'True', '123', '-1.5', '0x1F', '1e3', 'null', '~', '.inf'];
  for (const value of kinds) {
    expect(messages(`voice:\n  model_path: ${value}\n`)).toEqual([
      `2:voice.model_path must be a string; quote it so YAML does not read ${JSON.stringify(value)} as another kind of value`,
    ]);
  }
  // Plain words and quoted look-alikes are strings; YAML 1.2 does not treat yes/no/on/off specially.
  expect(messages('voice:\n  language: no\n  model_path: "123"\n  bin_path: "false"\n  threads: 4\ncontrol:\n  session: v1.2\n')).toEqual([]);
  // The runtime really does keep these as literal strings, so only the editor schema objects.
  expect(parseControlConfig('control:\n  session: false\n').session).toBe('false');
});

test('a key with an unbalanced opening quote is invalid YAML even though the runtime reads it', () => {
  const raw = 'control:\n  "enabled: false\n';
  expect(parseControlConfig(raw)).toEqual({ enabled: false });
  expect(messages(raw)).toEqual(['2:control has a key with an unbalanced quote: "\\"enabled"']);
  expect(messages('control:\n  "enabled\': false\n')).toHaveLength(1);
  expect(messages('control:\n  "enabled": false\n  \'topics\': true\n')).toEqual([]);
});

test('every documented schema example and default validates as written in the help', () => {
  const { properties } = generateConfigSchema();
  for (const [section, definition] of Object.entries(properties)) {
    for (const [key, setting] of Object.entries(definition.properties)) {
      for (const example of [...setting.examples, ...(setting.default === undefined ? [] : [setting.default])]) {
        const raw = `${section}:\n  ${key}: ${JSON.stringify(example)}\n`;
        expect({ raw, found: validateConfigText(raw) }).toEqual({ raw, found: [] });
      }
    }
  }
});

test('plain strings that YAML would parse as mappings or sequences are errors', () => {
  const invalid = (value: string) =>
    `2:control.session is not valid YAML as written; quote the value (got ${JSON.stringify(value)})`;
  for (const value of ['name: agents', '- small', '-', 'a:', '? key']) {
    expect(messages(`control:\n  session: ${value}\n`)).toEqual([invalid(value)]);
  }
  expect(messages('voice:\n  model_path: - small\n')).toEqual([
    '2:voice.model_path is not valid YAML as written; quote the value (got "- small")',
  ]);
  // Colons without a following space, hyphens inside words and paths, and quoted forms are fine.
  expect(messages('control:\n  session: a:b\n  inject_wrap: "name: {name}"\n')).toEqual([]);
  expect(messages('voice:\n  bin_path: /opt/whisper-cli/bin\n  model_path: -x\n')).toEqual([]);
});

test('quoted strings must be well formed inside as well as at the edges', () => {
  for (const value of ['"a"b"', '\'it\'s\'', '"bad\\"']) {
    expect(messages(`control:\n  session: ${value}\n`)).toEqual(['2:control.session has malformed quoting']);
  }
  expect(messages('control:\n  session: "say hi"\n  inject_wrap: \'it s\'\n')).toEqual([]);
});

test('empty sections are null in YAML but objects in the schema', () => {
  expect(messages('control:\nvoice:\nfeatures:\n')).toEqual([
    '1:control has no entries; remove it or add settings (YAML reads it as null)',
    '2:voice has no entries; remove it or add settings (YAML reads it as null)',
    '3:features has no entries; remove it or add settings (YAML reads it as null)',
  ]);
  expect(messages('control:\n  topics: true\nvoice:   # none yet\n')).toEqual([
    '3:voice has no entries; remove it or add settings (YAML reads it as null)',
  ]);
  expect(messages('control:\n  # only a comment\nvoice:\n  enabled: true\n')).toEqual([
    '1:control has no entries; remove it or add settings (YAML reads it as null)',
  ]);
  // An inline value already has its own diagnostic and is not reported twice.
  expect(messages('control: {}\n')).toHaveLength(1);
});

test('a non-mapping line right after an empty section still reports the empty section', () => {
  expect(messages('control:\nstray words\n')).toEqual([
    '1:control has no entries; remove it or add settings (YAML reads it as null)',
    '2:top level must be a mapping of control, voice and features blocks',
  ]);
});

test('the YAML key, not the runtime-normalized key, is what gets validated', () => {
  const raw = 'control:\n  enabled": false\n';
  expect(parseControlConfig(raw)).toEqual({ enabled: false });
  expect(messages(raw)).toEqual(['2:control.enabled" is not a known setting']);
});

test('double-quoted escapes must be valid YAML escapes', () => {
  for (const value of ['"\\q"', '"\\u12"', '"C:\\Users\\me"', '"\\x4"']) {
    expect(messages(`voice:\n  bin_path: ${value}\n`)).toEqual(['2:voice.bin_path has malformed quoting']);
  }
  // Single quotes keep a backslash literally in YAML and in the runtime alike.
  expect(messages('voice:\n  model_path: \'C:\\Users\'\n')).toEqual([]);
});

test('quoted forms the runtime does not decode differ from their YAML meaning and are errors', () => {
  const mismatch = (path: string) =>
    `2:${path} has a quoted escape that the runtime keeps literally, so its value would differ from the YAML meaning; write it without the escape`;
  for (const value of ['"/opt/my\\u0020tools/whisper"', '"a\\tb"', '"say \\"hi\\""', '"C:\\\\bin"']) {
    expect(messages(`voice:\n  bin_path: ${value}\n`)).toEqual([mismatch('voice.bin_path')]);
  }
  expect(messages("control:\n  session: 'it''s'\n")).toEqual([mismatch('control.session')]);
  expect(parseVoiceConfig('voice:\n  bin_path: "a\\tb"\n').binPath).toBe('a\\tb');
});

test('empty single-quoted strings are valid', () => {
  expect(messages("control:\n  allowed_senders: ''\n  session: \"\"\nvoice:\n  model_path: ''\n")).toEqual([]);
  expect(parseControlConfig("control:\n  allowed_senders: ''\n").allowedSenders).toEqual([]);
});

test('an unquoted value ending in a quote loses it in the runtime readers', () => {
  const raw = "voice:\n  model_path: /models/base'\n";
  expect(parseVoiceConfig(raw).modelPath).toBe('/models/base');
  expect(messages(raw)).toEqual([
    "2:voice.model_path ends with a quote character that the runtime strips, so its value would differ from the YAML meaning; quote the whole value",
  ]);
  expect(messages('voice:\n  model_path: say"\n')).toHaveLength(1);
  expect(messages("voice:\n  model_path: it's\n")).toEqual([]);
});

test('allowed sender IDs must be representable exactly', () => {
  const huge = '9'.repeat(400);
  expect(parseControlConfig(`control:\n  allowed_senders: ${huge}\n`).allowedSenders).toEqual([Infinity]);
  const tooLarge = (path = 'control.allowed_senders') => `2:${path} has an ID too large to match a Telegram user`;
  expect(messages(`control:\n  allowed_senders: ${huge}\n`)).toEqual([tooLarge()]);
  expect(messages('control:\n  allowed_senders: "1, 9007199254740993"\n')).toEqual([tooLarge()]);
  expect(messages('control:\n  allowed_senders: 9007199254740991\n')).toEqual([]);
});

test('plain strings that YAML itself cannot parse are rejected by the YAML syntax guard', () => {
  for (const value of [']abc', '}abc', 'a\u0000b']) {
    const errors = validateConfigText(`voice:\n  bin_path: ${value}\n`).filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(2);
    expect(errors[0].message.startsWith('not valid YAML: ')).toBe(true);
  }
});

test('the YAML syntax guard stays silent when line diagnostics already explain the file', () => {
  expect(messages('voice:\n  bin_path: ]abc\n  volume: 1\n')).toEqual(['3:voice.volume is not a known setting']);
});

test('signed hexadecimal and octal plain scalars are not strings for YAML', () => {
  for (const value of ['+0xFF', '-0xFF', '+0o17', '-0o17']) {
    expect(messages(`voice:\n  model_path: ${value}\n`)).toHaveLength(1);
  }
});

test('a CRLF entry with a trailing comment is ignored by the runtime readers, so it is an error', () => {
  const raw = 'control:\r\n  enabled: false # disable autostart\r\n';
  expect(parseControlConfig(raw)).toEqual({});
  expect(messages(raw)).toEqual([
    '2:control.enabled is on a CRLF line with a trailing comment; the runtime does not strip that comment and ignores the setting (use LF or remove the comment)',
  ]);
  expect(messages('control:\r\n  enabled: false\r\n')).toEqual([]);
  expect(messages('control: # block\r\n  enabled: false\r\n# note\r\n')).toEqual([]);
});

test('only spaces count as indentation', () => {
  expect(messages('control:\n\u00a0\u00a0enabled: false\n').length).toBeGreaterThan(0);
});

test('a second YAML document is an error because the editor schema allows one object', () => {
  expect(messages('---\n---\ncontrol:\n  enabled: false\n')).toEqual(['2:a second YAML document marker; keep one document in config.yaml']);
  expect(messages('---\ncontrol:\n  enabled: false\n---\n')).toEqual(['4:a second YAML document marker; keep one document in config.yaml']);
  expect(messages('---\ncontrol:\n  enabled: false\n')).toEqual([]);
});

test('legacy boolean tokens and CRLF section headers match the runtime readers', () => {
  for (const [token, expected] of [['yes', true], ['no', false], ['on', true], ['off', false], ['1', true], ['0', false], ['True', true], ['NO', false]] as const) {
    expect(parseControlConfig(`control:\n  topics: ${token}\n`).topics).toBe(expected);
    expect(parseFeatureConfig(`features:\n  hooks: ${token}\n`).hooks).toBe(expected);
    expect(parseVoiceConfig(`voice:\n  enabled: ${token}\n`).enabled).toBe(expected);
  }
  expect(parseControlConfig('control: # block\r\n  topics: true\r\n').topics).toBe(true);
  expect(parseVoiceConfig('voice: # block\r\n  enabled: true\r\n').enabled).toBe(true);
});

test('YAML 1.2 boolean spellings need no legacy warning', () => {
  expect(validateConfigText('control:\n  topics: True\nfeatures:\n  hooks: FALSE\n')).toEqual([]);
});
