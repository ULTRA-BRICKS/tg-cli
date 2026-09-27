// Original-process routing policy. No spawning, cwd/title guessing, or permission bypass.
import { randomUUID } from 'node:crypto';
export interface OriginalOmpEndpoint {
  pid: number; instanceId: string; sessionId: string; sessionFile: string | null;
  cwd: string; durableSession: string | null; busy: boolean | null; title: string | null;
}
export interface OriginalOmpTarget {
  pid?: number; instanceId?: string | null; sessionId?: string | null; cwd?: string | null;
}
export function selectOriginalEndpoint(target: OriginalOmpTarget, hosts: OriginalOmpEndpoint[]): OriginalOmpEndpoint {
  if (target.pid === undefined && !target.sessionId) throw new Error('exact_identity_required');
  const matches = target.pid !== undefined ? hosts.filter(h => h.pid === target.pid) : hosts.filter(h => h.sessionId === target.sessionId);
  if (matches.length === 0) throw new Error('endpoint_unavailable');
  if (matches.length !== 1) throw new Error('ambiguous_endpoint');
  const host = matches[0];
  if (target.sessionId && target.sessionId !== host.sessionId) throw new Error('stale_session');
  if (target.instanceId && target.instanceId !== host.instanceId) throw new Error('stale_identity');
  if (target.cwd && target.cwd !== host.cwd) throw new Error('session_cwd_mismatch');
  return host;
}
export function originalRequestId(text: string, messageId?: number | string): string {
  if (typeof messageId === 'string' && /^[A-Za-z0-9:_.-]{1,200}$/.test(messageId)) return messageId;
  if (typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId! > 0) return `tg:${messageId}`;
  // Only a bridge-authored header carries the inbound id; never scan the user's body.
  const match = /^\[TG[^\]\n]*\btg#(\d+)[^\]\n]*\]/.exec(text);
  return match ? `tg:${match[1]}` : `local:${randomUUID()}`;
}
