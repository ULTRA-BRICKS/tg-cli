/**
 * @file The unattached-file gate (feature `file-mention-guard`, ON by default): an agent
 * message whose own prose names an existing local document that the send does not attach
 * is refused before any API call, with the `tg --file …` command that delivers it.
 *
 * Accessed via: the `tg` entrypoint, next to the intent gate, on the final assembled body,
 * for the same senders (an agent in the ancestry or an agent env marker; not `--automated`).
 * Runs before `--dry-run`, so a dry run shows the refusal too.
 *
 * WHY: tg#22056 told the CTO "Черновик … ~/work/weekly-report-mari.md, проверь перед
 * отправкой" and attached nothing; on a phone a path is unreadable. Attaching it from the
 * text instead is ruled out: only explicit `--file`/`--photo` attach (tg-cli#648 — the old
 * text-path scan leaked unrelated files), so the gate refuses and names the flag.
 *
 * WHAT COUNTS: an absolute, `~/` or `./` path in the sender's prose (intent-gate.ts
 * `senderProse`: code, `<pre>`, backticks, quotes and URLs are not prose; a line starting
 * with `$ ` is a command example) that resolves to a document the reader would open: a
 * regular, non-empty file within the Bot API upload limit whose symlink-resolved path is
 * under the home or temp directory. A trailing `:42` / `#L42` location is not part of the path.
 * NOT COUNTED, because there the path is a reference rather than something to read (the
 * noise among the 23 of 1684 agent messages in the live history that named a file):
 * system files (`/etc/fstab`, `/usr/bin/env`), executables (`sudo ~/…/install.sh`), private
 * files with no group/other read bit (`~/.runpod/config.toml` holds an API key) and the
 * never-attach secrets (denylist.ts). Directories, missing files and paths with spaces do
 * not count either. A mention is attached when a `--file`/`--photo` names the same file
 * (same resolved path, or same dev:inode).
 *
 * PURE — the disk is the injected `stat`.
 */
import { resolve } from 'path';
import { isNeverAttach } from '../auto-attach/denylist';
import { expandHome } from './args';
import { senderProse } from './intent-gate';

/** The Bot API upload limit for sendDocument: a larger file cannot be attached anyway. */
export const MAX_ATTACH_BYTES = 50 * 1024 * 1024;

export interface FileIdentity {
  isFile: boolean;
  size: number;
  // st_mode permission bits.
  mode: number;
  // dev:inode — equal for two spellings of one file, symlinks included.
  id: string;
  // The path with every symlink resolved: what an upload would actually read.
  realPath: string;
}

export interface FileMentionDeps {
  cwd: string;
  home: string;
  // Real paths (symlinks resolved) of the directories documents live in: home and the temp
  // directory, where generated reports go.
  documentRoots: string[];
  // Follows symlinks; null when the path does not exist or cannot be read.
  stat: (absolutePath: string) => FileIdentity | null;
}

export interface UnattachedFile {
  // The path as the message wrote it.
  mention: string;
  // The absolute path to pass to `--file`.
  path: string;
}

// An absolute, `~/` or `./` path: starts after whitespace or an opening bracket/quote (not
// inside a word, a URL or `a/b`), runs to whitespace or a quote/bracket/comma/semicolon.
const PATH_RE = /(?<![\p{L}\p{N}_.~/\\:@$-])(?:~|\.)?\/[^\s"'`<>«»“”()[\]{}|,;]+/gu;
const TRAILING_PUNCT_RE = /[.:!?…]+$/u;
const LINE_SPEC_RE = /(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$/u;
const COMMAND_LINE_RE = /^\s*\$\s/u;

/** The path tokens in the sender's prose, in order, as written. No disk access. */
export function pathMentions(body: string): string[] {
  const out: string[] = [];
  for (const line of senderProse(body).split(/\r?\n/u)) {
    if (COMMAND_LINE_RE.test(line)) continue;
    for (const match of line.matchAll(PATH_RE)) {
      const token = match[0].replace(TRAILING_PUNCT_RE, '').replace(LINE_SPEC_RE, '').replace(TRAILING_PUNCT_RE, '');
      // A bare `/`, `~/` or `./` names no file.
      if (/^(?:~|\.)?\/?$/u.test(token)) continue;
      out.push(token);
    }
  }
  return out;
}

const EXECUTABLE_BITS = 0o111;
const SHARED_READ_BITS = 0o044;

// Whether the file at `path` is a document worth delivering (see WHAT COUNTS above). The
// symlink-resolved path decides, so `~/report.md -> /etc/hosts` is the system file it reads.
function isDocument(path: string, file: FileIdentity | null, deps: FileMentionDeps): file is FileIdentity {
  if (!file?.isFile || file.size === 0 || file.size > MAX_ATTACH_BYTES) return false;
  if ((file.mode & SHARED_READ_BITS) === 0 || (file.mode & EXECUTABLE_BITS) !== 0) return false;
  if (isNeverAttach(path) || isNeverAttach(file.realPath)) return false;
  return deps.documentRoots.some((root) => file.realPath.startsWith(`${root}/`));
}

/** The documents the prose names that exist and are not attached, each once. */
export function unattachedFileMentions(body: string, attachedPaths: string[], deps: FileMentionDeps): UnattachedFile[] {
  const absolute = (token: string): string => resolve(deps.cwd, expandHome(token, deps.home));
  const attachedPathSet = new Set(attachedPaths.map(absolute));
  const attachedIds = new Set(
    attachedPaths.map((p) => deps.stat(absolute(p))?.id).filter((id): id is string => id !== undefined),
  );
  const seen = new Set<string>();
  const out: UnattachedFile[] = [];
  for (const mention of pathMentions(body)) {
    const path = absolute(mention);
    if (attachedPathSet.has(path)) continue;
    const file = deps.stat(path);
    if (!isDocument(path, file, deps)) continue;
    if (attachedIds.has(file.id) || seen.has(file.id)) continue;
    seen.add(file.id);
    out.push({ mention, path });
  }
  return out;
}

// POSIX single-quoting, only when the word needs it.
function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

// A long or multi-line positional word is the message text: the resend command keeps its
// place instead of echoing it back. A word right after a flag is that flag's value (a long
// `--title`, a `--photo` path) and is echoed as is.
const ECHO_MAX = 80;

/**
 * The refusal: each unattached file and the exact command that sends the message with them.
 * `--dry-run` is left out of that command — it refuses attachments, so the fix is a send.
 * `rowsOnStdin`: a `--table` send, whose rows argv cannot carry — the command says to pipe
 * them again.
 */
export function formatUnattachedFileError(files: UnattachedFile[], argv: string[], rowsOnStdin = false): string {
  const fileFlags = files.flatMap((f) => ['--file', shellQuote(f.path)]);
  const words = argv.filter((word) => word !== '--dry-run');
  const isMessageText = (word: string, i: number): boolean =>
    (word.length > ECHO_MAX || word.includes('\n')) && !word.startsWith('-') && !(words[i - 1] ?? '').startsWith('-');
  const rest = words.map((word, i) => (isMessageText(word, i) ? "'<the same message text>'" : shellQuote(word)));
  const plural = files.length > 1;
  return [
    `the message names ${plural ? `${files.length} local files` : 'a local file'} without attaching ${plural ? 'them' : 'it'}:`,
    ...files.map((f) => `  ${f.mention}`),
    `The reader sees only a path and cannot open it on a phone. Send it with the ${plural ? 'files' : 'file'} attached:`,
    `  ${rowsOnStdin ? '<the same table rows> | ' : ''}tg ${[...fileFlags, ...rest].join(' ')}`,
    'Blocked: nothing was sent.',
  ].join('\n');
}
