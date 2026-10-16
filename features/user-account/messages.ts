// Human text for sidecar results and error codes. PURE. The sidecar speaks stable codes
// (never library exception text, which can carry auth data); this is the WHAT/HOW layer.
import type { Role, UserAccountCommand } from './args';

/** `tg auth user` for the user's own account, `tg auth caller` for the ringing account. */
export function authCommand(role: Role): string {
  return role === 'personal' ? 'tg auth user' : 'tg auth caller';
}

export function notLoggedIn(role: Role, path: string): string {
  const who = role === 'personal' ? 'your Telegram account' : 'the caller account (the one that rings you)';
  return `Error: not logged in to ${who} (no ${path}). Run: ${authCommand(role)}`;
}

/** The `--file` a sidecar refusal is about, and the upload limit it hit. */
export interface FileRefusal {
  file?: string;
  limitMib?: number;
}

export function describeError(code: string, role: Role, peer?: string, refusal: FileRefusal = {}): string {
  const auth = authCommand(role);
  const target = peer ?? 'the peer';
  const file = refusal.file ?? 'the file';
  const limit = refusal.limitMib ?? 2000;
  const parts = shellWord(`${file}.part-`);
  const text: Record<string, string> = {
    SESSION_MISSING: `not logged in. Run: ${auth}`,
    SESSION_ALREADY_EXISTS: `already logged in. To switch accounts run \`${auth} logout\`, then \`${auth}\`.`,
    SESSION_UNAUTHORIZED: `Telegram no longer accepts this session (terminated in Settings → Devices?). Run \`${auth} logout\`, then \`${auth}\`.`,
    ACCOUNT_IDENTITY_MISMATCH: 'that is not the expected account (or it is a bot). Nothing was saved.',
    ACCOUNTS_MUST_DIFFER: 'the caller must be a different account from your own — an account cannot ring itself.',
    LOGIN_REQUIRES_PRIVATE_TERMINAL: `login prompts need an interactive terminal. Run \`${auth}\` yourself in a terminal.`,
    API_ID_INVALID: 'the API ID is the number shown at https://my.telegram.org/apps.',
    API_HASH_MISSING: 'the API hash from https://my.telegram.org/apps is required.',
    QR_LOGIN_TIMEOUT: `the QR code was not scanned in time. Run \`${auth} --qr\` again, or log in by phone: \`${auth}\`.`,
    ACCOUNT_NOT_REGISTERED: 'that phone number has no Telegram account.',
    SOURCE_SESSION_OWNERSHIP_NOT_CONFIRMED:
      'this session was imported and is shared with the app it came from. Stop that app, then add --source-idle-confirmed.',
    PEER_INVALID: `'${target}' is not a peer: use @username, a numeric user id, or me.`,
    PEER_NOT_FOUND: `Telegram could not find ${target} for this account. Use their @username, or make sure you have a chat with them.`,
    PEER_IS_BOT: `${target} is a bot; bots cannot take calls.`,
    CALL_RECIPIENT_IS_CALLER: 'an account cannot ring itself. `tg call me` rings you from the caller account (tg auth caller).',
    CALL_INCOMPLETE: `${target} did not take the call (declined, busy or no answer); the audio was not played to the end. Not retried.`,
    CALL_DEPENDENCIES_MISSING: 'the call libraries are missing from the sidecar runtime (pyrofork, py-tgcalls, ntgcalls).',
    AUDIO_FILE_MISSING: 'the --audio file does not exist.',
    TTS_UNAVAILABLE: 'no text-to-speech on this host (macOS `say` or `espeak-ng`). Record the message and pass --audio <file>.',
    TTS_FAILED: 'text-to-speech failed. Pass a recorded file with --audio <file>.',
    TEXT_EMPTY: 'the message text is empty.',
    TEXT_TOO_LONG: 'the text is too long (send: 4096 characters, --say: 1000).',
    CAPTION_TOO_LONG: 'the caption is too long (1024 characters with --file).',
    FILE_MISSING: `'${file}' is not a readable regular file.`,
    FILE_EMPTY: `'${file}' is empty; Telegram does not take empty files.`,
    FILE_TOO_LARGE:
      `'${file}' is over the ${limit} MiB per-file upload limit. Split it and send the parts: ` +
      `split -b 1900M -- ${shellWord(file)} ${parts} (rejoin with cat -- ${parts}* > ${shellWord(file)}).`,
    CLIENT_ALREADY_RUNNING: 'another tg process is using this account right now; try again when it finishes.',
    INSECURE_STORE_DIRECTORY: 'the session directory is not private (must be yours, mode 0700).',
    INSECURE_STORE_FILE: 'the session file is not private (must be yours, mode 0600).',
    INVALID_AUTH_STORE: `the session file is unreadable. Run \`${auth} logout\`, then \`${auth}\`.`,
  };
  return `Error: ${text[code] ?? `the Telegram sidecar failed (${code}).`}`;
}

/** One POSIX shell word, so a copied recovery command survives quotes and metacharacters. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

type Json = Record<string, unknown>;

/** One line for a sidecar answer that is not an error (dry-run plans and status included). */
export function describeResult(cmd: UserAccountCommand, out: Json): string {
  switch (cmd.kind) {
    case 'login':
    case 'import': {
      const who = out.username ? `@${out.username} ` : '';
      const verb = cmd.kind === 'login' ? 'Logged in as' : 'Imported session for';
      return `${verb} ${who}(id ${out.user_id}). ${cmd.kind === 'import' ? 'Online use needs --source-idle-confirmed.' : `Check: ${authCommand(cmd.role)} status --online`}`;
    }
    case 'status':
      return out.configured
        ? `${authCommand(cmd.role)}: logged in, account id ${out.expected_id} (${out.origin})${out.online_verified ? `, online as @${out.username ?? out.user_id}` : ', not checked online'}.`
        : `${authCommand(cmd.role)}: not logged in. Run: ${authCommand(cmd.role)}`;
    case 'logout':
      return `Removed the local session. The login stays listed in Telegram → Settings → Devices until you terminate it there.`;
    case 'call':
      if (out.dry_run) {
        const missing = Array.isArray(out.missing) ? out.missing : [];
        const to = out.recipient_id ? `id ${out.recipient_id}` : String(out.peer);
        return missing.length === 0
          ? `Dry run: ready to call ${to} from the ${cmd.role} account (${out.media}${out.tts_engine ? ` via ${out.tts_engine}` : ''}).`
          : `Dry run: not ready to call ${to}; missing: ${missing.join(', ')}.`;
      }
      return `Called ${cmd.peer}: the audio played to the end.`;
    case 'send': {
      if (!out.dry_run) {
        const ids = Array.isArray(out.message_ids) ? out.message_ids : [];
        return ids.length > 0
          ? `Sent ${ids.length} file${ids.length === 1 ? '' : 's'} to ${cmd.peer} as you (message${ids.length === 1 ? '' : 's'} ${ids.join(', ')}).`
          : `Sent to ${cmd.peer} as you (message ${out.message_id}).`;
      }
      const missing = Array.isArray(out.missing) ? out.missing : [];
      const files: unknown[] = Array.isArray(out.files) ? out.files : [];
      const bytes = files.reduce<number>(
        (sum, f) => sum + (typeof f === 'object' && f !== null && 'bytes' in f && typeof f.bytes === 'number' ? f.bytes : 0),
        0,
      );
      const what = files.length > 0
        ? `${files.length} file${files.length === 1 ? '' : 's'} (${size(bytes)})` +
          (Number(out.characters) > 0 ? ` with a ${out.characters}-character caption` : '')
        : `${out.characters} characters`;
      return missing.length === 0
        ? `Dry run: ready to send ${what} to ${cmd.peer} as id ${out.user_id}.`
        : `Dry run: not ready to send to ${cmd.peer}; missing: ${missing.join(', ')}.`;
    }
  }
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
