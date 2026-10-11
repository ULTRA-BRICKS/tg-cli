// Pure opencode adapter helpers for question/permission forwarding.
//
// The daemon owns SSE subscription and fetch (opencode-bridge.ts). This file only
// translates opencode event payloads into tg-ctl button requests and reply HTTP plans.
//
// Two wire generations: opencode 1.x events carry `properties` and reply on
// `/question|permission/{id}/reply`; opencode 2.x (verified against 2.0.20's
// `/openapi.json` and live `/api/event` stream, tests/fixtures/opencode) carries `data`,
// asks questions as `form.created` forms and replies on `/api/session/{id}/...`.

import type { ButtonOption, ButtonRequest } from './questions';
import { opencodeSessionRole, type OpencodeSessionRecord } from '../agent-role/role';

export interface OpencodeEvent {
  type?: string;
  properties?: Record<string, unknown>;
  data?: unknown;
}

export interface OpencodeReplyPlan {
  method: 'POST';
  url: string;
  body:
    | { answers: string[][] }
    | { reply: 'once' | 'reject'; message?: string }
    | { decision: 'once' | 'reject'; message?: string }
    | { answer: Record<string, string> };
}

// `session` is the opencode session record of `properties.sessionID` (`GET /session/:id`),
// fetched by the caller: a child session (`parentID` set) is a `task` subagent and its
// ask is labelled with it (docs/specs/agent-role-model.md §3). A record that does not
// carry this session's id is ignored, never applied.
export function opencodeEventToButtonRequest(event: OpencodeEvent, session?: OpencodeSessionRecord): ButtonRequest | null {
  if (event.type === 'form.created') return formToButtonRequest(event.data, session);
  const p = event.properties ?? recordOf(event.data) ?? {};
  const sessionId = stringField(p, 'sessionID') ?? stringField(p, 'sessionId');
  const requestId = stringField(p, 'requestID') ?? stringField(p, 'requestId') ?? stringField(p, 'id');
  if (!sessionId || !requestId) return null;
  const subagent = subagentLabel(sessionId, session);

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
    // Only the 2.x envelope (`data`, no `properties`) answers on the session-scoped `/api` route.
    const replyKind = event.type === 'permission.v2.asked'
      ? 'permission-v2'
      : event.properties ? 'permission' : 'permission-api';
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
  const ref = req.opencode;
  if (!ref) return null;
  const root = baseUrl.replace(/\/+$/, '');
  const sessionId = encodeURIComponent(ref.sessionId);
  const requestId = encodeURIComponent(ref.requestId);
  const plan = (path: string, body: OpencodeReplyPlan['body']): OpencodeReplyPlan => ({ method: 'POST', url: `${root}${path}`, body });
  switch (ref.replyKind) {
    case 'permission':
      return plan(`/permission/${requestId}/reply`, permissionReplyBody(answer));
    case 'permission-v2':
      return plan(`/api/session/${sessionId}/permission/request/${requestId}/reply`, permissionReplyBody(answer));
    case 'permission-api': {
      const { reply, message } = permissionReplyBody(answer);
      return plan(`/api/session/${sessionId}/permission/${requestId}/reply`, message ? { decision: reply, message } : { decision: reply });
    }
    case 'question':
      return plan(`/question/${requestId}/reply`, { answers: [[answer]] });
    case 'question-v2':
      return plan(`/api/session/${sessionId}/question/request/${requestId}/reply`, { answers: [[answer]] });
    case 'form': {
      if (!ref.form) return null;
      // The card shows option labels; the form wants the option's value.
      const value = Object.hasOwn(ref.form.values, answer) ? ref.form.values[answer] : answer;
      return plan(`/api/session/${sessionId}/form/${requestId}/reply`, { answer: { [ref.form.fieldKey]: value } });
    }
    default:
      return null; // an unknown kind (a newer peer's request): no route to guess
  }
}

// opencode 2.x `form.created`: `data.form` = { id, sessionID, title, fields[] }. Exactly one
// visible single-choice string field with concrete options and `custom: false` maps to
// buttons; anything else (free text, multiselect, several fields) stays in the terminal.
function formToButtonRequest(data: unknown, session: OpencodeSessionRecord | undefined): ButtonRequest | null {
  const form = recordOf(recordOf(data)?.form);
  if (!form) return null;
  const sessionId = stringField(form, 'sessionID');
  const formId = stringField(form, 'id');
  if (!sessionId || !formId || !Array.isArray(form.fields) || form.fields.length !== 1) return null;
  const field = recordOf(form.fields[0]);
  if (!field || field.type !== 'string' || field.custom !== false) return null;
  const fieldKey = stringField(field, 'key');
  if (!fieldKey || !Array.isArray(field.options)) return null;
  const values: Record<string, string> = {};
  const options: ButtonOption[] = [];
  for (const item of field.options) {
    const rec = recordOf(item);
    const label = rec && stringField(rec, 'label');
    const value = rec && stringField(rec, 'value');
    if (!rec || !label || !value) continue;
    // A tap comes back as the label, so two options sharing one could reply the wrong value.
    if (Object.hasOwn(values, label)) return null;
    values[label] = value;
    const description = stringField(rec, 'description');
    options.push(description ? { label, description } : { label });
  }
  if (!options.length) return null;
  const title = stringField(form, 'title');
  const subagent = subagentLabel(sessionId, session);
  return {
    requestId: localRequestId(sessionId, formId),
    agent: 'opencode',
    kind: 'question',
    title,
    question: stringField(field, 'title') ?? stringField(field, 'description') ?? title ?? fieldKey,
    options,
    opencode: { sessionId, requestId: formId, replyKind: 'form', form: { fieldKey, values } },
    ...(subagent ? { subagent } : {}),
  };
}

function subagentLabel(sessionId: string, session: OpencodeSessionRecord | undefined): string | undefined {
  const verified = session && session.id === sessionId ? session : undefined;
  return opencodeSessionRole(verified).label;
}

export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
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
