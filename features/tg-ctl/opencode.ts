// Pure opencode adapter helpers for question/permission forwarding.
//
// The daemon owns SSE subscription and fetch. This file only translates
// opencode event payloads into tg-ctl button requests and reply HTTP plans.

import type { ButtonOption, ButtonRequest } from './questions';
import { opencodeSessionRole, type OpencodeSessionRecord } from '../agent-role/role';

export interface OpencodeEvent {
  type?: string;
  properties?: Record<string, unknown>;
}

export interface OpencodeReplyPlan {
  method: 'POST';
  url: string;
  body: { answers: string[][] } | { reply: 'once' | 'reject'; message?: string };
}

// `session` is the opencode session record of `properties.sessionID` (`GET /session/:id`),
// fetched by the caller: a child session (`parentID` set) is a `task` subagent and its
// ask is labelled with it (docs/specs/agent-role-model.md §3). A record that does not
// carry this session's id is ignored, never applied.
export function opencodeEventToButtonRequest(event: OpencodeEvent, session?: OpencodeSessionRecord): ButtonRequest | null {
  const p = event.properties ?? {};
  const sessionId = stringField(p, 'sessionID') ?? stringField(p, 'sessionId');
  const requestId = stringField(p, 'requestID') ?? stringField(p, 'requestId') ?? stringField(p, 'id');
  if (!sessionId || !requestId) return null;
  const verified = session && session.id === sessionId ? session : undefined;
  const subagent = opencodeSessionRole(verified).label;

  if (event.type === 'question.asked' || event.type === 'question.v2.asked') {
    if (Array.isArray(p.questions) && p.questions.length !== 1) return null;
    const questionInfo = firstQuestion(p.questions) ?? p;
    if (questionInfo.multiple === true) return null;
    if (questionInfo.custom !== false) return null;
    const question = stringField(questionInfo, 'question');
    if (!question) return null;
    const options = optionList(questionInfo.options);
    if (!options) return null;
    const replyKind = event.type === 'question.v2.asked' ? 'question-v2' : 'question';
    return {
      requestId: localRequestId(sessionId, requestId),
      agent: 'opencode',
      kind: 'question',
      title: stringField(questionInfo, 'header') ?? stringField(questionInfo, 'title'),
      question,
      options,
      opencode: { sessionId, requestId, replyKind },
      ...(subagent ? { subagent } : {}),
    };
  }

  if (event.type === 'permission.asked' || event.type === 'permission.v2.asked') {
    const title = stringField(p, 'permission') ?? stringField(p, 'action') ?? stringField(p, 'title') ?? 'Permission request';
    const details = permissionDetails(p);
    const replyKind = event.type === 'permission.v2.asked' ? 'permission-v2' : 'permission';
    return {
      requestId: localRequestId(sessionId, requestId),
      agent: 'opencode',
      kind: 'permission',
      title,
      question: [title, ...details].join('\n'),
      opencode: { sessionId, requestId, replyKind },
      ...(subagent ? { subagent } : {}),
    };
  }

  return null;
}

export function opencodeReplyPlan(baseUrl: string, req: ButtonRequest, answer: string): OpencodeReplyPlan | null {
  if (!req.opencode) return null;
  const root = baseUrl.replace(/\/+$/, '');
  const sessionId = encodeURIComponent(req.opencode.sessionId);
  const requestId = encodeURIComponent(req.opencode.requestId);
  const path = req.opencode.replyKind === 'permission-v2'
    ? `/api/session/${sessionId}/permission/request/${requestId}/reply`
    : req.opencode.replyKind === 'permission'
      ? `/permission/${requestId}/reply`
      : req.opencode.replyKind === 'question-v2'
        ? `/api/session/${sessionId}/question/request/${requestId}/reply`
        : `/question/${requestId}/reply`;
  return {
    method: 'POST',
    url: `${root}${path}`,
    body: req.opencode.replyKind === 'permission' || req.opencode.replyKind === 'permission-v2'
      ? permissionReplyBody(answer)
      : { answers: [[answer]] },
  };
}

function localRequestId(sessionId: string, requestId: string): string {
  return `oc_${safeId(sessionId)}_${safeId(requestId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value ? value : undefined;
}

function optionList(value: unknown): ButtonOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: ButtonOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const label = stringField(rec, 'label');
    if (!label) continue;
    const description = stringField(rec, 'description');
    options.push(description ? { label, description } : { label });
  }
  return options.length ? options : undefined;
}

function firstQuestion(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const first = value[0];
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
}

function metadataCommand(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  return stringField(rec, 'command') ?? stringField(rec, 'description');
}

function permissionDetails(p: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const metadata = p.metadata && typeof p.metadata === 'object' ? (p.metadata as Record<string, unknown>) : null;
  const command = metadataCommand(p.metadata);
  if (command) lines.push(command);
  else if (metadata && metadata.input !== undefined) lines.push(`input: ${briefValue(metadata.input)}`);
  appendListLine(lines, 'patterns', p.patterns);
  appendListLine(lines, 'resources', p.resources);
  appendListLine(lines, 'always', p.always);
  if (p.tool && typeof p.tool === 'object') lines.push(`tool: ${briefValue(p.tool)}`);
  return lines;
}

function appendListLine(lines: string[], label: string, value: unknown): void {
  const values = valueList(value);
  if (values.length) lines.push(`${label}: ${values.join(', ')}`);
}

function valueList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(briefValue).filter((v) => v.length > 0);
}

function briefValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function permissionReplyBody(answer: string): { reply: 'once' | 'reject'; message?: string } {
  if (answer === 'deny' || answer === 'reject') return { reply: 'reject', message: 'Rejected from Telegram' };
  return { reply: 'once' };
}
