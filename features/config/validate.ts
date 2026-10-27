// Read-only config.yaml validation for `tg config validate`. It checks the
// canonical editor-schema shape (generateConfigSchema) but scans lines the same
// way the runtime readers do (parseControlConfig/parseVoiceConfig/
// parseFeatureConfig), so anything those readers would silently skip is an
// error here rather than accepted. Pure: the caller reads the file and prints.
import { generateConfigSchema, PATTERN_HINTS, type ConfigSettingSchema } from './schema';

export interface ConfigDiagnostic {
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

const TRUE_TOKENS = new Set(['true', 'yes', 'on', '1']);
const FALSE_TOKENS = new Set(['false', 'no', 'off', '0']);
// The only settings whose runtime reader strips quotes before interpreting them.
const RUNTIME_UNQUOTES = new Set(['voice.enabled', 'voice.threads']);

// YAML 1.2 core-schema scalars that are not strings when unquoted, plus plain-scalar
// indicators. The runtime keeps all of these as literal text; a YAML parser would not.
const NON_STRING_YAML = new RegExp(
  '^(?:[Tt]rue|TRUE|[Ff]alse|FALSE|[Nn]ull|NULL|~|[-+]?[0-9]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+' +
  '|[-+]?(?:\\.[0-9]+|[0-9]+(?:\\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$' +
  '|^[[{|>&*!%@`]',
);

// A plain scalar cannot contain ": " or start a sequence/complex key; quoted forms must close properly.
const INVALID_PLAIN_YAML = /:(?:\s|$)|^-(?:\s|$)|^\?(?:\s|$)/;
const WELL_FORMED_QUOTED =
  /^(?:"(?:[^"\\]|\\(?:[0abt\tnvfre "/\\N_LP]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}))*"|'(?:[^']|'')*')$/;

const label = (key: string): string => (/^[\w.-]+$/.test(key) ? key : JSON.stringify(key));
const isQuoted = (s: string): boolean => s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.endsWith(s[0]);

type Emit = (severity: 'error' | 'warning', message: string) => void;

function checkValue(path: string, definition: ConfigSettingSchema, value: string, emit: Emit): void {
  const types = Array.isArray(definition.type) ? definition.type : [definition.type];
  if (value[0] === '"' || value[0] === "'") {
    if (!isQuoted(value)) {
      emit('error', `${path} has an unbalanced quote`);
      return;
    }
    if (!WELL_FORMED_QUOTED.test(value)) {
      emit('error', `${path} has malformed quoting`);
      return;
    }
    // YAML decodes \-escapes (double quotes) and '' (single quotes); the runtime only strips the quotes.
    if ((value[0] === '"' && value.includes('\\')) || (value[0] === "'" && value.slice(1, -1).includes("''"))) {
      emit('error', `${path} has a quoted escape that the runtime keeps literally, so its value would differ from the YAML meaning; write it without the escape`);
      return;
    }
  }
  if (!isQuoted(value) && /["']$/.test(value)) {
    emit('error', `${path} ends with a quote character that the runtime strips, so its value would differ from the YAML meaning; quote the whole value`);
    return;
  }
  const quoted = isQuoted(value);
  const inner = quoted ? value.slice(1, -1) : value;
  const unquotedByRuntime = !quoted || RUNTIME_UNQUOTES.has(path);

  if (types.includes('string')) {
    if (definition.enum && !definition.enum.includes(inner)) {
      emit('error', `${path} must be one of ${definition.enum.join(', ')} (got ${JSON.stringify(inner)})`);
    } else if (definition.pattern && !new RegExp(definition.pattern).test(inner)) {
      emit('error', `${path} must be ${PATTERN_HINTS[path] ?? 'in the documented format'} (got ${JSON.stringify(value)})`);
    } else if (types.includes('integer') && inner.split(',').some((id) => !Number.isSafeInteger(Number(id.trim() || '0')))) {
      emit('error', `${path} has an ID too large to match a Telegram user`);
    } else if (!quoted && !types.includes('integer') && NON_STRING_YAML.test(value)) {
      emit('error', `${path} must be a string; quote it so YAML does not read ${JSON.stringify(value)} as another kind of value`);
    } else if (!quoted && INVALID_PLAIN_YAML.test(value)) {
      emit('error', `${path} is not valid YAML as written; quote the value (got ${JSON.stringify(value)})`);
    }
    return;
  }
  if (types.includes('boolean')) {
    if (!quoted && /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/.test(value)) return;
    const token = inner.toLowerCase();
    if (unquotedByRuntime && (TRUE_TOKENS.has(token) || FALSE_TOKENS.has(token))) {
      emit('warning', `${path}: ${JSON.stringify(inner)} is accepted by the runtime; the editor schema expects true or false`);
    } else {
      emit('error', `${path} must be true or false (got ${JSON.stringify(value)})`);
    }
    return;
  }
  if (types.includes('integer')) {
    const decimal = /^-?\d+$/.test(inner);
    // voice.threads is read with Number(), which also accepts +4, 4.0, 1e1 and 0x10.
    const runtimeNumber = RUNTIME_UNQUOTES.has(path) && inner.trim() !== '' ? Number(inner) : Number.NaN;
    if (!unquotedByRuntime || (!decimal && !Number.isInteger(runtimeNumber))) {
      emit('error', `${path} must be an integer (got ${JSON.stringify(value)})`);
      return;
    }
    const n = decimal ? Number(inner) : runtimeNumber;
    if (!Number.isInteger(n)) {
      emit('error', `${path} is too large to be a valid integer`);
    } else if (definition.minimum !== undefined && n < definition.minimum) {
      emit('error', `${path} must be at least ${definition.minimum} (got ${n})`);
    } else if (quoted || !decimal) {
      const expected = quoted && decimal ? 'an unquoted integer' : 'a plain decimal integer';
      emit('warning', `${path}: ${JSON.stringify(inner)} is accepted by the runtime; the editor schema expects ${expected}`);
    }
  }
}

/** Diagnostics in file order; an empty list means the configuration is fully canonical. */
export function validateConfigText(raw: string): ConfigDiagnostic[] {
  const schema = generateConfigSchema();
  const out: ConfigDiagnostic[] = [];
  const sectionLines = new Map<string, number>();
  const keyLines = new Map<string, number>();
  let section: string | undefined;
  let blockIndent: number | undefined;
  let sectionLine = 0;
  let sectionEntries = 0;
  let sawContent = false;
  let sawDocumentStart = false;
  let reportedNonMapping = false;

  // A section with no entries is YAML null, which the object schema rejects.
  const closeSection = () => {
    if (section !== undefined && sectionEntries === 0) {
      out.push({ line: sectionLine, severity: 'error', message: `${section} has no entries; remove it or add settings (YAML reads it as null)` });
    }
  };

  raw.split('\n').forEach((rawLine, index) => {
    const lineNo = index + 1;
    const emit: Emit = (severity, message) => out.push({ line: lineNo, severity, message });
    // Same comment stripping as the runtime readers.
    const line = rawLine.replace(/\r$/, '').replace(/\s+#.*$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (trimmed === '---') {
      if (!sawContent && !sawDocumentStart) {
        sawDocumentStart = true;
        return;
      }
      emit('error', 'a second YAML document marker; keep one document in config.yaml');
      closeSection();
      section = undefined;
      return;
    }
    const first = !sawContent;
    sawContent = true;
    // trimStart() counts a BOM as indentation, so the runtime skips a key it precedes.
    if (index === 0 && line.startsWith('\uFEFF')) {
      emit('error', 'a byte-order mark directly before a key makes the runtime read the line as indented and ignore it; start the file with a comment or remove the mark');
      section = undefined;
      return;
    }

    const indent = line.length - line.trimStart().length;
    const nonMapping = () => {
      if (!reportedNonMapping) emit('error', 'top level must be a mapping of control, voice and features blocks');
      reportedNonMapping = true;
      closeSection();
      section = undefined;
    };

    if (indent === 0) {
      const colon = trimmed.indexOf(':');
      const rest = colon === -1 ? '' : trimmed.slice(colon + 1);
      if (colon === -1 || trimmed.startsWith('-') || (rest !== '' && !/^\s/.test(rest))) return nonMapping();
      const key = trimmed.slice(0, colon);
      closeSection();
      section = undefined;
      blockIndent = undefined;
      if (!Object.hasOwn(schema.properties, key)) {
        emit('error', `${label(key)} is not a known top-level key (expected control, voice or features)`);
        return;
      }
      section = key;
      sectionLine = lineNo;
      sectionEntries = rest.trim() === '' ? 0 : 1;
      const firstLine = sectionLines.get(key);
      if (firstLine !== undefined) emit('error', `${key} is duplicated (first on line ${firstLine})`);
      else sectionLines.set(key, lineNo);
      if (rest.trim() !== '') emit('error', `${key} must be a block of indented key: value lines; the runtime ignores an inline value`);
      return;
    }

    if (section === undefined) {
      // An indented first line is a document the runtime reads as nothing at all.
      if (first) nonMapping();
      return;
    }
    sectionEntries++;
    if (/\t/.test(line.slice(0, indent))) emit('error', 'tab indentation is not valid YAML');
    else if (/[^ ]/.test(line.slice(0, indent))) emit('error', 'indentation must be spaces only; YAML reads other whitespace as part of the key');
    if (blockIndent === undefined) blockIndent = indent;
    else if (indent !== blockIndent) {
      emit('error', `${section}: indentation differs from the first entry; the runtime reads each indented line as a one-level key`);
    }

    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      emit('error', `${section} has a line that is not "key: value"; the runtime ignores it`);
      return;
    }
    const rawKey = trimmed.slice(0, colon).trim();
    if ((rawKey[0] === '"' || rawKey[0] === "'") && !WELL_FORMED_QUOTED.test(rawKey)) {
      emit('error', `${section} has a key with an unbalanced quote: ${JSON.stringify(rawKey)}`);
      return;
    }
    const key = isQuoted(rawKey) ? rawKey.slice(1, -1) : rawKey;
    const afterColon = trimmed.slice(colon + 1);
    const path = `${section}.${key}`;
    if (afterColon !== '' && !/^\s/.test(afterColon)) {
      emit('error', `${path} needs a space after the colon; YAML reads ${JSON.stringify(trimmed)} as one string`);
      return;
    }
    const value = afterColon.trim();
    const seen = keyLines.get(path);
    if (seen !== undefined) emit('error', `${path} is duplicated (first on line ${seen})`);
    else keyLines.set(path, lineNo);
    // The runtime strips comments before the CR, so `\s+#.*$` never reaches a CRLF line's end.
    if (rawLine.endsWith('\r') && /\s+#/.test(rawLine)) {
      emit('error', `${path} is on a CRLF line with a trailing comment; the runtime does not strip that comment and ignores the setting (use LF or remove the comment)`);
    }

    const properties: Record<string, ConfigSettingSchema> = schema.properties[section as keyof typeof schema.properties].properties;
    const definition = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (!definition) {
      emit('error', `${path} is not a known ${section === 'features' ? 'feature' : 'setting'}`);
      return;
    }
    if (value === '') {
      emit('error', `${path} has an empty value; the runtime ignores it (nested mappings are unsupported)`);
      return;
    }
    checkValue(path, definition, value, emit);
  });
  closeSection();
  const diagnostics = out.sort((a, b) => a.line - b.line);
  // Last line of defence, only once the line checks are clean: the subset checks above never
  // reach inside scalars, so let the real YAML parser reject whatever syntax they did not model.
  // Anchors and collections were already rejected, so alias expansion cannot be reached.
  if (typeof Bun.YAML?.parse !== 'function') {
    diagnostics.push({ line: 1, severity: 'warning', message: 'YAML syntax check skipped: Bun.YAML needs Bun 1.2.21 or newer' });
    diagnostics.sort((a, b) => a.line - b.line);
  } else if (!diagnostics.some((d) => d.severity === 'error')) {
    const syntaxError = (text: string): string | undefined => {
      try {
        Bun.YAML.parse(text);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message.replace(/^YAML Parse error:\s*/, '') : 'syntax error';
      }
    };
    const detail = syntaxError(raw);
    if (detail !== undefined) {
      // The parser reports no usable line; every prefix of a clean flat mapping is valid YAML,
      // so the first failing prefix ends on the offending line.
      const lines = raw.split('\n');
      let low = 1;
      let high = lines.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (syntaxError(lines.slice(0, mid).join('\n')) === undefined) low = mid + 1;
        else high = mid;
      }
      diagnostics.push({ line: low, severity: 'error', message: `not valid YAML: ${detail}` });
      diagnostics.sort((a, b) => a.line - b.line);
    }
  }
  return diagnostics;
}

export const CONFIG_VALIDATE_USAGE = `Usage: tg config validate

Check <config dir>/config.yaml (TG_CTL_CONFIG_DIR selects the directory) against
the canonical settings in tg help config. Read-only: no credentials, network, or
file changes. A missing file is valid; defaults apply.

Exit 0: valid (legacy forms the runtime accepts are warnings).
Exit 1: an error, or the file cannot be read.
`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Render diagnostics as compiler-style stderr lines plus a one-line stdout verdict. */
export function renderValidation(path: string, diagnostics: ConfigDiagnostic[]): { stdout: string; stderr: string; code: 0 | 1 } {
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.length - errors;
  const stderr = diagnostics.map((d) => `${path}:${d.line}: ${d.severity}: ${d.message}\n`).join('');
  if (errors > 0) {
    const tail = warnings > 0 ? `, ${plural(warnings, 'warning')}` : '';
    return { stdout: `${path}: ${plural(errors, 'error')}${tail}\n`, stderr, code: 1 };
  }
  return { stdout: `${path}: valid${warnings > 0 ? ` (${plural(warnings, 'warning')})` : ''}\n`, stderr, code: 0 };
}
