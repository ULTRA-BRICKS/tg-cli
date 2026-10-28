// `tg config validate` for the `laya:` block. Its keys and values are read and validated by the
// Python caller only (src/tgcli/laya, `check-config`), so no rule exists twice: this module blanks
// the block (keeping every line number) before the generic validator sees the file, and rewrites the
// two "expected control, voice, features" messages that would otherwise omit the fourth section.
import { validateConfigText, type ConfigDiagnostic } from './validate';

/** The file with the whole top-level `laya:` block replaced by blank lines. */
export function withoutLayaBlock(raw: string): string {
  let inBlock = false;
  return raw.split('\n').map((line) => {
    const text = line.replace(/\r$/, '');
    if (/^\S/.test(text) && !text.startsWith('#')) inBlock = /^laya\s*:/.test(text);
    return inBlock ? '' : line;
  }).join('\n');
}

/** Generic diagnostics of everything except the laya block, plus the caller's check of that block. */
export function validateConfigWithLaya(raw: string, layaDiagnostics: ConfigDiagnostic[]): ConfigDiagnostic[] {
  const generic = validateConfigText(withoutLayaBlock(raw)).map((d) => ({
    ...d,
    message: d.message
      .replace('(expected control, voice or features)', '(expected control, voice, features or laya)')
      .replace('mapping of control, voice and features blocks', 'mapping of control, voice, features and laya blocks'),
  }));
  return [...generic, ...layaDiagnostics].sort((a, b) => a.line - b.line);
}
