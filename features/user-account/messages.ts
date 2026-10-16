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

export function describeError(code: string, role: Role, peer?: string): string {
  const auth = authCommand(role);
  const target = peer ?? 'the peer';
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
    CALL_ATTEMPT_FAILED: 'the call attempt failed; no automatic retry. Inspect the call id below in tg call history.',
    CALL_TOKEN_ALREADY_USED: 'this idempotency token already has an attempt. Inspect tg call history before making a new call.',
    CALL_TOPIC_MAPPING_UNVERIFIED: 'bot topics cannot be mapped to a private calling-account chat. Omit --topic to send the transcript to the exact recipient.',
    WATCH_CALL_REQUIRES_IDENTIFIED_SERVICE: 'watch-call is unavailable until it uses the identified call service.',
    CONVERSATION_REQUIRES_IDENTIFIED_SERVICE: 'native conversational calls are unavailable until they use the identified call service.',
    CALL_DEPENDENCIES_MISSING: 'the call libraries are missing from the sidecar runtime (pyrofork, py-tgcalls, ntgcalls).',
    AUDIO_FILE_MISSING: 'the --audio file does not exist.',
    TTS_CONFIG_MISSING: 'create <tg config>/voice.json with the verified provider, model, voice_id and credential_source reference. Run tg call --dry-run to inspect it.',
    TTS_CONFIG_INVALID: 'correct voice.json schema and ownership/permissions; use a credential_source reference instead of an inline API key.',
    TTS_ENDPOINT_UNTRUSTED: 'use the canonical Fish HTTPS endpoint https://api.fish.audio/v1/tts in voice.json.',
    TTS_CREDENTIAL_UNAVAILABLE: 'restore the referenced environment value or the exact unique fish_audio Home Assistant entry; its existing file may be owned by you or root and must not be group/world writable. Do not copy the key.',
    TTS_PROVIDER_FAILED: 'check the configured Fish account and connectivity. The selected voice was not changed; do not retry a call automatically.',
    TTS_PROVIDER_TIMEOUT: 'the configured Fish provider exceeded its deadline. Check connectivity/account health before manually starting another attempt.',
    TTS_AUDIO_INVALID: 'the configured provider returned invalid or unsupported audio. Check its WAV output before manually making another call.',
    TTS_OUTPUT_FAILED: 'speech preparation needs a fresh private output directory and writable storage.',
    TTS_METADATA_INVALID: 'speech preparation produced invalid metrics; inspect the configured TTS adapter before another attempt.',
    TTS_UNAVAILABLE: 'the explicitly configured host provider needs macOS `say` or `espeak-ng`. Install its engine or explicitly configure the intended neural voice in voice.json; raw audio still needs the spoken introduction.',
    TTS_FAILED: 'the explicitly configured host speech engine failed. Check that engine before starting another call; raw audio still needs the spoken introduction.',
    TEXT_EMPTY: 'the message text is empty.',
    TEXT_TOO_LONG: 'the text is too long (send: 4096 characters, --say: 1000).',
    CLIENT_ALREADY_RUNNING: 'another tg process is using this account right now; try again when it finishes.',
    INSECURE_STORE_DIRECTORY: 'the session directory is not private (must be yours, mode 0700).',
    INSECURE_STORE_FILE: 'the session file is not private (must be yours, mode 0600).',
    INVALID_AUTH_STORE: `the session file is unreadable. Run \`${auth} logout\`, then \`${auth}\`.`,
  };
  return `Error: ${text[code] ?? `the Telegram sidecar failed (${code}).`}`;
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
    case 'call-history':
      return JSON.stringify(out);
    case 'call':
      if (out.dry_run) {
        const missing = Array.isArray(out.missing) ? out.missing : [];
        const to = out.recipient_id ? `id ${out.recipient_id}` : String(out.peer);
        const voice = out.tts;
        const identity = typeof voice === 'object' && voice !== null && 'provider' in voice
          ? `; voice ${String(voice.provider)}${'model' in voice && voice.model ? ` / ${String(voice.model)}` : ''}${'voice_id' in voice && voice.voice_id ? ` / ${String(voice.voice_id)}` : ''} (credentials and provider not checked)` : '';
        const reasons = Array.isArray(out.missing_reasons) ? out.missing_reasons.flatMap(reason =>
          typeof reason === 'object' && reason !== null && 'component' in reason && reason.component === 'tts' && 'code' in reason
            ? [describeError(String(reason.code), cmd.role, cmd.peer)] : []) : [];
        return missing.length === 0
          ? `Dry run: ready to call ${to} from the ${cmd.role} account (${out.media}${out.tts_engine ? ` via ${out.tts_engine}` : ''}${identity}).`
          : `Dry run: not ready to call ${to}; missing: ${missing.join(', ')}${identity}.${reasons.length ? ` ${reasons.join(' ')}` : ''}`;
      }
      return `Called ${cmd.peer}: the outbound audio stream ended (not a listening receipt). Call ${out.call_id}.`;
    case 'send': {
      if (!out.dry_run) return `Sent to ${cmd.peer} as you (message ${out.message_id}).`;
      const missing = Array.isArray(out.missing) ? out.missing : [];
      return missing.length === 0
        ? `Dry run: ready to send ${out.characters} characters to ${cmd.peer} as id ${out.user_id}.`
        : `Dry run: not ready to send to ${cmd.peer}; missing: ${missing.join(', ')}.`;
    }
  }
}
