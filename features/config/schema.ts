// Configuration reference shared by editor schemas and CLI help. Runtime
// parsers stay unchanged; defaults come from the modules that resolve them.
// Everything here is pure: callers own config paths, stdout, and file I/O.
import { DEFAULT_FEATURES } from '../auto-attach/feature-flags';
import { DEFAULT_CONTROL, type ControlConfig } from '../tg-ctl/types';
import { DEFAULT_VOICE, type VoiceConfig } from '../tg-ctl/voice';

type ScalarType = 'boolean' | 'integer' | 'string';
type Scalar = boolean | number | string;

interface Setting {
  key: string;
  type: ScalarType | ScalarType[];
  description: string;
  enum?: string[];
  minimum?: number;
  pattern?: string;
  unsetDefault?: string;
  examples?: Scalar[];
}

// Mapped types describe exhaustive metadata, including optional fields.
// Bun does not typecheck; tests enforce runtime-default coverage and verify
// every example through the actual parsers as well.
type Settings<T> = { [K in keyof T]-?: Setting };

const controlSettings = {
  enabled: {
    key: 'enabled', type: 'boolean',
    description: "Allow tg's lazy autostart of tg-ctl after a successful send from a detected agent inside tmux. This switch does not disable buttons or registrations, stop a running daemon, or block explicit daemon starts.",
  },
  transport: {
    key: 'transport', type: 'string', enum: ['auto', 'tmux', 'channel'], examples: ['auto', 'tmux'],
    description: 'Legacy transport selector. auto and tmux retain the current routing; channel is reserved and currently logs a warning and falls back to tmux.',
  },
  session: {
    key: 'session', type: 'string', unsetDefault: 'unset (auto-discover)', examples: ['agents'],
    description: 'Pin tmux discovery to this session name. An explicit session registration from tg-ctl start --session takes precedence; omit to auto-discover.',
  },
  injectWrap: {
    key: 'inject_wrap', type: 'string',
    description: 'Template around inbound text. Placeholders: {name} is the sender name, {msg} is the message text, and {id} is its tg# message reference.',
  },
  stalenessSec: {
    key: 'staleness_sec', type: 'integer', minimum: 1, examples: [600],
    description: 'Legacy age setting in seconds, retained for compatibility. The daemon does not drop inbound messages by age.',
  },
  idleExitMin: {
    key: 'idle_exit_min', type: 'integer', minimum: 1, examples: [15],
    description: 'Minutes without a live agent before the daemon exits. Agents outside tmux and recent registrations also count as activity.',
  },
  allowedSenders: {
    key: 'allowed_senders', type: ['string', 'integer'], minimum: 0,
    pattern: '^\\s*(?:[0-9]+(?:\\s*,\\s*[0-9]+)*)?\\s*$',
    examples: ['123456789, 987654321', 123456789],
    description: 'Additional allowed Telegram user IDs as a comma-separated scalar (for example "123, 456") or a single integer. An empty string adds none. YAML arrays are not supported.',
  },
  topics: {
    key: 'topics', type: 'boolean',
    description: 'Enable forum-topic routing in a supergroup. Requires a forum supergroup with the bot allowed to manage topics.',
  },
  privateTopics: {
    key: 'private_topics', type: 'boolean',
    description: 'Enable topics for sessions in a private bot chat. If the bot lacks the private-topic capability, session creation asks whether to continue without topics or cancel. Topic-creation API errors fall back to flat-chat behavior with a diagnostic.',
  },
  gitStateBanner: {
    key: 'git_state_banner', type: 'boolean',
    description: 'Prepend a warning when a fresh non-reply message is automatically routed into a pane whose repository has uncommitted changes or a non-main branch.',
  },
} satisfies Settings<ControlConfig>;

// Plain-language shape of settings that carry a pattern, for validation messages.
export const PATTERN_HINTS: Record<string, string> = {
  'control.allowed_senders': 'comma-separated user IDs or a single integer',
};

const voiceSettings = {
  enabled: {
    key: 'enabled', type: 'boolean',
    description: 'Enable local transcription of inbound voice notes. A usable binary and model are required; tg voice setup discovers or installs them and writes this block. An explicit false opts out of automatic setup.',
  },
  runner: {
    key: 'runner', type: 'string', enum: ['whisper.cpp', 'faster-whisper'], examples: ['whisper.cpp', 'faster-whisper'],
    description: 'Local Whisper runner. whisper.cpp uses a native executable; faster-whisper uses a Python environment. Setup may choose a runner suited to the host.',
  },
  binPath: {
    key: 'bin_path', type: 'string', examples: ['/opt/whisper/bin/whisper-cli'],
    description: 'Path to whisper-cli (or its legacy main executable) for whisper.cpp, or to the virtual-environment Python executable for faster-whisper.',
  },
  modelPath: {
    key: 'model_path', type: 'string', examples: ['/opt/whisper/models/ggml-base.bin', 'large-v3-turbo'],
    description: 'Path to a ggml model file for whisper.cpp, or a model-size token (such as large-v3-turbo) or converted model directory for faster-whisper.',
  },
  language: {
    key: 'language', type: 'string', examples: ['en', 'auto'],
    description: 'Language token passed to the runner, or auto for automatic language detection. An empty value resolves to auto.',
  },
  threads: {
    key: 'threads', type: 'integer', minimum: 1, unsetDefault: 'unset (physical core count)', examples: [4],
    description: 'CPU thread count. Omit to use the physical core count. A custom faster-whisper transcription script must accept --threads when this setting is supplied.',
  },
} satisfies Settings<VoiceConfig>;

// DEFAULT_FEATURES is typed as Record<string, boolean>, so its exact key set
// cannot be enforced by a mapped type. config-schema.test.ts compares the
// generated keys with that runtime map to catch additions and removals.
const featureDescriptions: Record<string, string> = {
  'autolink-tasks': 'Resolve Linear task references and add task links and titles to outbound messages.',
  'autolink-prs': 'Resolve GitHub issue and pull-request references against the current repository and add links and titles.',
  'autolink-msgrefs': 'Recognize tg# message references and link them when the chat supports a message URL.',
  'autolink-msgref-preview': 'Quote a referenced Telegram message inline when local history contains it. Requires autolink-msgrefs.',
  'md-as-pdf': 'Convert explicitly attached Markdown files to PDF for readable Telegram previews.',
  'code-as-pdf': 'Convert explicitly attached code and configuration files to a mobile-sized, highlighted PDF. --with-original and --no-pdf adjust attachment behavior.',
  'attach-denylist': 'Refuse explicit attachments that look like secret files, including environment files, keys, and credentials.',
  'flood-cap': 'Limit the number of Telegram messages produced by one fragmented send.',
  'cjk-guard': 'Reject isolated CJK characters inside otherwise Latin or Cyrillic words and mixed-script garbage tokens; ordinary CJK text remains supported.',
  'screenshot-guard': 'Require a photo attachment when the caption or title claims to show a screenshot.',
  'file-mention-guard': 'Refuse an agent message that names an existing local document without attaching it, and suggest the explicit --file command.',
  hooks: 'Run pre-send-photo hooks when hook descriptors are installed. AGENTS_HOOKS=0 bypasses these hooks.',
};

export interface ConfigSettingSchema {
  type: ScalarType | ScalarType[];
  description: string;
  examples: Scalar[];
  default?: Scalar;
  enum?: string[];
  minimum?: number;
  pattern?: string;
}

interface ConfigSectionSchema {
  type: 'object';
  description: string;
  additionalProperties: false;
  properties: Record<string, ConfigSettingSchema>;
}

export interface ConfigSchema {
  $schema: string;
  title: string;
  description: string;
  type: 'object';
  additionalProperties: false;
  properties: Record<'control' | 'voice' | 'features', ConfigSectionSchema>;
}

function settingProperties(settings: Record<string, Setting>, defaults: object): Record<string, ConfigSettingSchema> {
  const values = defaults as Record<string, unknown>;
  return Object.fromEntries(Object.entries(settings).map(([runtimeKey, setting]) => {
    const { key, unsetDefault: _unsetDefault, examples, ...metadata } = setting;
    const definition: ConfigSettingSchema = {
      ...metadata,
      examples: examples ? [...examples] : [],
      type: Array.isArray(setting.type) ? [...setting.type] : setting.type,
      ...(setting.enum ? { enum: [...setting.enum] } : {}),
    };
    const value = values[runtimeKey];
    // allowedSenders is a runtime array, but its YAML representation is CSV.
    if (Array.isArray(value)) definition.default = value.join(', ');
    else if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      definition.default = value;
    }
    if (!examples && definition.default !== undefined) definition.examples = [definition.default];
    return [key, definition];
  }));
}

/** Build a fresh editor schema. Validation is advisory; runtime parsers are unchanged. */
export function generateConfigSchema(): ConfigSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'tg-cli configuration',
    description: 'Canonical config.yaml settings for tg and tg-ctl. Credentials belong in .env. See tg help config for runtime compatibility and precedence.',
    type: 'object',
    additionalProperties: false,
    properties: {
      control: {
        type: 'object', description: 'Inbound control and daemon settings.', additionalProperties: false,
        properties: settingProperties(controlSettings, DEFAULT_CONTROL),
      },
      voice: {
        type: 'object', description: 'Local transcription of inbound voice notes.', additionalProperties: false,
        properties: settingProperties(voiceSettings, DEFAULT_VOICE),
      },
      features: {
        type: 'object', description: 'Outbound feature flags. --feature and --no-feature override these values.', additionalProperties: false,
        properties: Object.fromEntries(Object.entries(featureDescriptions).map(([key, description]) => [key, {
          type: 'boolean' as const, description, default: DEFAULT_FEATURES[key], examples: [DEFAULT_FEATURES[key]],
        }])),
      },
    },
  };
}

/** Stable bytes for the checked-in artifact and the file beside config.yaml. */
export function configSchemaText(): string {
  return JSON.stringify(generateConfigSchema(), null, 2) + '\n';
}

function settingType(setting: ConfigSettingSchema): string {
  const type = Array.isArray(setting.type) ? setting.type.join(' or ') : setting.type;
  if (setting.enum) return `${type}; ${setting.enum.join(' | ')}`;
  if (setting.minimum !== undefined) return `${type}; minimum ${setting.minimum}`;
  return type;
}

function exampleConfig(schema: ConfigSchema): string[] {
  const fields: [keyof ConfigSchema['properties'], string[]][] = [
    ['control', ['enabled', 'idle_exit_min']],
    ['voice', ['enabled']],
    ['features', ['autolink-msgrefs']],
  ];
  return [
    '# yaml-language-server: $schema=./config.schema.json',
    ...fields.flatMap(([section, keys]) => [
      `${section}:`,
      ...keys.map((key) => `  ${key}: ${JSON.stringify(schema.properties[section].properties[key].examples[0])}`),
    ]),
  ];
}

/** Print the complete reference without reading config files or credentials. */
export function renderConfigHelp(configDir = '~/.config/tg-cli'): string {
  const directory = configDir.replace(/\/+$/, '');
  const schema = generateConfigSchema();
  const optionalDefaults: Record<string, string> = {
    'control.session': controlSettings.session.unsetDefault,
    'voice.threads': voiceSettings.threads.unsetDefault,
  };
  const lines = [
    'tg configuration reference',
    '',
    `Configuration: ${directory}/config.yaml`,
    `Editor schema: ${directory}/config.schema.json`,
    'Set TG_CTL_CONFIG_DIR to select a different configuration directory.',
    'The schema is refreshed beside config.yaml during configuration reads/writes.',
    'Editor modeline: # yaml-language-server: $schema=./config.schema.json',
    '',
    'Precedence and credentials',
    '  Runtime defaults are overridden by config.yaml. Feature flags are then',
    '  overridden by --feature NAME / --no-feature NAME (--no-feature wins a tie).',
    `  Credentials live in ${directory}/.env: TG_BOT_TOKEN and TG_CHAT_ID.`,
    '  The shell environment overrides .env values. Set up credentials with tg auth.',
    '',
    'control.enabled scope',
    "  This only gates tg's lazy autostart after an agent send inside tmux.",
    '  It does not turn off buttons, registrations, OS autostart, or a running daemon.',
    '  Explicit tg-ctl run and tg-ctl start still work. Use tg-ctl stop to stop the',
    '  daemon now, or tg-ctl disable to remove OS autostart and stop it.',
    '',
    'File syntax and compatibility',
    '  Use top-level control:, voice:, and features: blocks with one-level scalar',
    '  entries. The editor schema recommends unquoted true/false and plain decimal',
    '  integers. The runtime also accepts unquoted yes/no, on/off, and 1/0 booleans.',
    '  Only voice.enabled accepts quoted booleans; control and features do not.',
    '  voice.threads also accepts quoted numeric values; control integer values',
    '  must be unquoted decimal digits. Invalid values usually retain defaults.',
    '  Unknown control/voice keys are ignored; unknown feature names are retained',
    '  by the feature parser but do not add a feature. The schema flags unknown',
    '  keys to catch mistakes. Full YAML constructs and YAML arrays are unsupported.',
    '  Omit unused blocks; use control.enabled: false or voice.enabled: false',
    '  for their respective opt-outs.',
    '',
    'Validation',
    '  tg config validate checks config.yaml read-only: no credentials, network, or',
    '  file changes; a missing file is valid. Errors (exit 1) are unknown keys, values',
    '  the runtime ignores or heals (wrong type, enum, or range), unreadable or',
    '  non-mapping files, and YAML the one-level readers skip (inline blocks, nested',
    '  mappings, duplicates, inconsistent indentation, quoted section names, empty',
    '  sections) and quoted escapes the runtime keeps literally (\\t, \'\').',
    '  A final syntax pass runs Bun.YAML.parse (Bun 1.2.21 or newer; older Bun skips it',
    '  with a warning) and rejects text the line checks did not model.',
    '  Warnings (exit 0) are legacy forms the runtime accepts but the editor schema',
    '  flags: yes/no, on/off, 1/0 booleans and quoted voice.enabled/voice.threads.',
    '',
    'Example config.yaml (credentials stay in .env):',
    ...exampleConfig(schema),
    '',
  ];
  for (const [section, definition] of Object.entries(schema.properties)) {
    lines.push(`${section}:`, `  ${definition.description}`, '');
    for (const [key, setting] of Object.entries(definition.properties)) {
      const path = `${section}.${key}`;
      const value = setting.default === undefined ? optionalDefaults[path] : JSON.stringify(setting.default);
      lines.push(`  ${path} (${settingType(setting)})`, `    Default: ${value}`, `    ${setting.description}`,
        ...setting.examples.map((example) => `    Example: ${key}: ${JSON.stringify(example)}`), '');
    }
  }
  return lines.join('\n');
}
