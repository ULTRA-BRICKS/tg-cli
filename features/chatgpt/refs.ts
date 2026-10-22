// PURE (de)serialization and rules for the durable /chatgpt callback-reference store
// (CtlPaths.chatgptRefs). The tg-ctl entrypoint owns the file I/O (atomic tmp+rename, 0600).
//
// A button's callback_data is `cgp:<id>` — an OPAQUE random id. The only thing that can come back
// from a tap is that id; what it MEANS (kind, account, chat, bound turn, owner chat, expiry,
// used) lives here, in a FIXED schema validated on every read. The store never holds arbitrary pm
// JSON, chat titles or free text, so a forged or tampered record can at worst name one of the
// enumerated kinds against a syntactically valid account/chat.

import { isChatId, isRequestId, isWorkspace, type WorkspaceScope } from './model';
import { isRecord } from '../tg-ctl/guards';

export const REF_PREFIX = 'cgp:';
export const REF_TTL_MS = 15 * 60 * 1000;
export const MAX_REFS = 400;
const STORE_VERSION = 1;
const ID_RE = /^[A-Za-z0-9_-]{16,40}$/;

export const REF_KINDS = ['details', 'refresh', 'requests', 'request-status', 'pause', 'resume', 'watch', 'continue'] as const;
export type RefKind = (typeof REF_KINDS)[number];

// Kinds that ask pm to change something (each only QUEUES an owner approval inside pm).
export const STATE_CHANGING_KINDS = ['pause', 'resume', 'watch', 'continue'] as const;
export type StateChangingKind = (typeof STATE_CHANGING_KINDS)[number];

export interface RefRecord {
  id: string;
  kind: RefKind;
  workspace: WorkspaceScope;
  chat: string | null;
  expectedTurn: string | null; // the turn a Continue was rendered against
  requestId: string | null; // the request a status tap reads
  ownerChatId: number;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export interface RefStore {
  version: typeof STORE_VERSION;
  refs: RefRecord[];
}

export function emptyRefStore(): RefStore {
  return { version: STORE_VERSION, refs: [] };
}

export function refData(id: string): string {
  return `${REF_PREFIX}${id}`;
}

export function idOfRefData(data: string): string | null {
  if (!data.startsWith(REF_PREFIX)) return null;
  const id = data.slice(REF_PREFIX.length);
  return ID_RE.test(id) ? id : null;
}

export function isStateChanging(kind: RefKind): kind is StateChangingKind {
  return (STATE_CHANGING_KINDS as readonly string[]).includes(kind);
}

function nullableText(value: unknown, valid: (v: string) => boolean): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && valid(value) ? value : undefined;
}

function parseRecord(raw: unknown): RefRecord | null {
  if (!isRecord(raw)) return null;
  const { id, kind, workspace, ownerChatId, createdAt, expiresAt, used } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof kind !== 'string' || !(REF_KINDS as readonly string[]).includes(kind)) return null;
  if (workspace !== 'all' && !isWorkspace(workspace)) return null;
  if (typeof ownerChatId !== 'number' || !Number.isSafeInteger(ownerChatId) || ownerChatId === 0) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  if (typeof used !== 'boolean') return null;
  const chat = nullableText(raw.chat, isChatId);
  const expectedTurn = nullableText(raw.expectedTurn, isChatId);
  const requestId = nullableText(raw.requestId, isRequestId);
  if (chat === undefined || expectedTurn === undefined || requestId === undefined) return null;
  const record: RefRecord = { id, kind: kind as RefKind, workspace, chat, expectedTurn, requestId, ownerChatId, createdAt, expiresAt, used };
  // Per-kind consistency: a record that cannot act on a concrete target is not a valid reference.
  if ((record.kind === 'details' || isStateChanging(record.kind)) && (record.workspace === 'all' || record.chat === null)) return null;
  if (record.kind === 'continue' && record.expectedTurn === null) return null;
  if (record.kind === 'request-status' && record.requestId === null) return null;
  return record;
}

// Anything unreadable (not JSON, wrong version, wrong shape) is an empty store; bad records are dropped.
export function parseRefStore(content: string | null): RefStore {
  if (content === null) return emptyRefStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return emptyRefStore();
  }
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.refs)) return emptyRefStore();
  const refs = parsed.refs.map(parseRecord).filter((r): r is RefRecord => r !== null);
  return { version: STORE_VERSION, refs };
}

// Drops expired records and bounds the file to the newest MAX_REFS.
export function pruneRefs(store: RefStore, nowMs: number): RefStore {
  const live = store.refs.filter((r) => r.expiresAt > nowMs);
  return { version: STORE_VERSION, refs: live.length > MAX_REFS ? live.slice(live.length - MAX_REFS) : live };
}

export function serializeRefStore(store: RefStore): string {
  const refs = store.refs.map((r) => ({
    id: r.id,
    kind: r.kind,
    workspace: r.workspace,
    chat: r.chat,
    expectedTurn: r.expectedTurn,
    requestId: r.requestId,
    ownerChatId: r.ownerChatId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    used: r.used,
  }));
  return `${JSON.stringify({ version: STORE_VERSION, refs })}\n`;
}
