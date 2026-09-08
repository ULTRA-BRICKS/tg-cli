// Shared types for the auto-attach pipeline.
//
// A SendItem is either a real on-disk file (path) OR in-memory content with a
// filename. The in-memory branch exists from day one so that R4 fragment files
// and marker-injected line-spec copies (spec §Line-spec / §R4) need no disk
// writes — the transmitter uploads a Blob built from `content`. This avoids
// retrofitting every layer when those rules land in later phases.

export type Format = 'plain' | 'html';

export interface DiskSource {
  kind: 'disk';
  path: string;
}

export interface MemorySource {
  kind: 'memory';
  filename: string;
  content: string;
}

export type Source = DiskSource | MemorySource;

export interface SendItem {
  type: 'photo' | 'document';
  source: Source;
}

// A single outgoing text message. Length-splitting is the transmitter's job;
// the normalization layer just produces logical messages.
export interface TextMessage {
  text: string;
  format: Format;
}

// The fully-normalized, ordered plan. The transmitter sends in the order
// photos → textMessages → documents (spec §Ordering, the "sandwich").
export interface SendPlan {
  photos: SendItem[];
  textMessages: TextMessage[];
  documents: SendItem[];
}

// Telegram hard limits (spec §Caption overflow / §Message splitting).
export const CAPTION_LIMIT = 1024;
export const MESSAGE_LIMIT = 4096;

// tg-cli#208: a plain/basic-HTML body that would fragment into more than this
// many separate Telegram sendMessage calls is refused rather than silently
// flooding the recipient. Does not apply to rich bodies (sendRichMessage — never
// split) or to a caption (bounded by CAPTION_LIMIT, far below this threshold).
export const FLOOD_CAP_MAX_MESSAGES = 6;
