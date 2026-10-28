// Path helpers for explicit --photo/--file values (pure path math + one statSync).
import { statSync } from 'fs';
import { join, resolve } from 'path';

// Extensions that Telegram's sendPhoto accepts. SVG is intentionally excluded:
// Telegram rejects SVG as a photo (explicit --photo still honors the user's choice).
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif']);

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export function expandHome(token: string, home: string): string {
  if (token === '~') return home;
  if (token.startsWith('~/')) return join(home, token.slice(2));
  return token;
}

// ~-expand, then make absolute against cwd and normalize (`resolve` collapses
// `.`/`..` in absolute paths too, so `/etc/../etc/hosts` equals `/etc/hosts`).
// Pure path math, no disk access.
export function absolutePath(token: string, cwd: string, home: string): string {
  return resolve(cwd, expandHome(token, home));
}

/**
 * Resolve an explicit --photo/--file value to an existing file path, if it is one.
 * Tries ~-expansion, absolute, and cwd-relative resolution.
 * Returns the absolute path only when it resolves to a real file (not a dir).
 */
export function resolveExistingFile(token: string, cwd: string, home: string): string | null {
  if (!token) return null;
  const candidate = absolutePath(token, cwd, home);
  try {
    if (statSync(candidate).isFile()) return candidate;
  } catch {
    // not a path / no access
  }
  return null;
}
