// Help text for `tg call --help` and `tg user send --help`. `tg auth user|caller` is part of
// the one `tg auth` help (AUTH_USAGE, features/auth/args.ts). Keep in step with
// docs/specs/independent-telegram-clients.md §1.
import type { HelpTopic } from './args';

const CALL = `Usage:
  tg call <peer> --say "<text>" [--from user|caller] [--timeout <s>] [--dry-run] [--json]
  tg call <peer> --audio <file> [...]
  tg call <peer> --say="-text that starts with a dash"

Rings <peer> once and plays the audio (or speaks the text with macOS \`say\` / espeak-ng).
Success = the audio played to the end; a declined or unanswered call is not retried.
  <peer>             @username, numeric user id, or me
  me                 you: rung FROM the caller account (tg auth caller) — an account
                     cannot ring itself
  --from user        call from your own account (default)
  --from caller      call from the caller account
  --timeout <s>      bound for ringing and for playback (default 60)
  --dry-run          check sessions, audio/TTS, ffmpeg and call libraries; connect to nothing
  --source-idle-confirmed
                     required for an imported session: its source app is stopped
  --json             print the sidecar's JSON lines

A flag is never taken as a value: \`--say --dry-run\` is an error (exit 2), not a call
that speaks "--dry-run". Log in first: tg auth user / tg auth caller (tg help auth).

Example: tg call me --say "Тони написал в Telegram"`;

const USER_SEND = `Usage:
  tg user send <peer> [text…]      send as YOUR account (tg auth user); text or stdin
  echo "text" | tg user send <peer>
  tg user send <peer> -- --text that starts with dashes
  <peer>   @username, numeric id (negative for groups), or me (Saved Messages)
  --dry-run   validate without connecting (anywhere before \`--\`); --json raw output
  --source-idle-confirmed   required for an imported session`;

export const USER_ACCOUNT_HELP: Record<HelpTopic, string> = {
  call: CALL,
  'user-send': USER_SEND,
};
