import { expect, test } from "bun:test";
import { buildReplyInject, stepUpdates, type StepOpts } from "../features/tg-ctl/updates";
import { DEFAULT_CONTROL, type TgMessage, type TgUpdate } from "../features/tg-ctl/types";

const CHAT_ID = 1000;
const NOW = 1_750_000_000;
const REPLIED_AT = 1_700_000_000;

const opts: StepOpts = {
  cfg: { ...DEFAULT_CONTROL },
  chatId: CHAT_ID,
  nowSec: NOW,
  currentOffset: 0,
  wrap: (name, msg) => `[TG from ${name}] ${msg} — reply via tg`,
  fmtTime: () => "2026-06-12 14:30",
};

// A realistic (non-zero) id — tg-cli#28 renders it as `tg#<id>` in the anchor
// (distinct from a zero/falsy id, which must NOT collapse the token away).
const REPLIED_TO_ID = 42;

const replied = (text: string, id: number = REPLIED_TO_ID): TgMessage => ({
  message_id: id,
  chat: { id: CHAT_ID },
  date: REPLIED_AT,
  text,
});

const reply = (text: string, rtmText: string, quote?: string, rtmId?: number): TgMessage => ({
  message_id: 9,
  from: { id: CHAT_ID, first_name: "Alex" },
  chat: { id: CHAT_ID },
  date: NOW,
  text,
  reply_to_message: replied(rtmText, rtmId),
  ...(quote ? { quote: { text: quote } } : {}),
});

// --- buildReplyInject ---

test("partial quote is forwarded as the quote anchor (item 2)", () => {
  const out = buildReplyInject(
    reply("fix the bug", "Deployed auth and migrated the DB", "migrated the DB"),
    "Alex",
    opts,
  );
  expect(out).toBe(
    "↩ tg#42 «[2026-06-12 14:30] migrated the DB…»\n[TG from Alex] fix the bug — reply via tg",
  );
});

test("long partial quote is kept complete, not truncated like a whole-message reply", () => {
  const rawSelected = `selected  ${"part ".repeat(12)}\nwith line break`.trim();
  const selected = rawSelected.replace(/\s+/g, " ");
  const out = buildReplyInject(
    reply("answer this exact part", `prefix ${rawSelected} suffix`, rawSelected),
    "Alex",
    opts,
  );
  const anchor = out.split("\n")[0];
  expect(selected.length).toBeGreaterThan(60);
  expect(anchor).toBe(`↩ tg#42 «[2026-06-12 14:30] ${selected}…»`);
});

test("whitespace-only partial quote falls back to the original message preview", () => {
  const out = buildReplyInject(
    reply("answer this", "Original message body", " \n\t "),
    "Alex",
    opts,
  );
  const anchor = out.split("\n")[0];
  expect(anchor).toBe("↩ tg#42 «[2026-06-12 14:30] Original message body…»");
});

test("no partial quote → beginning of the replied-to message (item 3)", () => {
  const out = buildReplyInject(reply("do it", "Short original message", undefined), "Alex", opts);
  expect(out).toBe(
    "↩ tg#42 «[2026-06-12 14:30] Short original message…»\n[TG from Alex] do it — reply via tg",
  );
});

test("long original is truncated to the head + ellipsis", () => {
  const long = "x".repeat(120);
  const out = buildReplyInject(reply("y", long, undefined), "Alex", opts);
  const anchor = out.split("\n")[0];
  expect(anchor).toBe(`↩ tg#42 «[2026-06-12 14:30] ${"x".repeat(60)}…»`);
});

test("whitespace-only original without partial quote falls back to ellipsis only", () => {
  const out = buildReplyInject(
    reply("answer empty-looking message", " \n\t ", undefined),
    "Alex",
    opts,
  );
  const anchor = out.split("\n")[0];
  expect(anchor).toBe("↩ tg#42 «[2026-06-12 14:30] …»");
});

test("multiline original/quote is collapsed to one anchor line", () => {
  const out = buildReplyInject(reply("ok", "line one\nline two", "line\none"), "Alex", opts);
  expect(out.split("\n")[0]).toBe("↩ tg#42 «[2026-06-12 14:30] line one…»");
});

test("default UTC formatter is deterministic when fmtTime is omitted", () => {
  const o: StepOpts = { ...opts, fmtTime: undefined };
  const out = buildReplyInject(reply("a", "b", undefined), "Alex", o);
  expect(out.split("\n")[0]).toMatch(/^↩ tg#42 «\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] b…»$/);
});

test("the original id in the anchor is the replied-to message id, not the reply's own id", () => {
  const out = buildReplyInject(reply("follow up", "earlier report", undefined, 5975), "Alex", opts);
  // 9 is the reply's own message_id (opts.wrap ignores it here — the fake
  // wrap fn takes no id param); 5975 is the ORIGINAL id, and only it must
  // appear in the anchor.
  expect(out.split("\n")[0]).toBe("↩ tg#5975 «[2026-06-12 14:30] earlier report…»");
  expect(out).not.toContain("tg#9 ");
});

test("a falsy (zero) original id still renders — no silent collapse", () => {
  const out = buildReplyInject(reply("ok", "zero-id original", undefined, 0), "Alex", opts);
  expect(out.split("\n")[0]).toBe("↩ tg#0 «[2026-06-12 14:30] zero-id original…»");
});

// --- stepUpdates integration ---

function upd(id: number, m: TgMessage): TgUpdate {
  return { update_id: id, message: m };
}

test("reply with prose → reply-route with the quote anchor (carrying the original tg#id) + ack", () => {
  const r = stepUpdates(
    [upd(1, reply("please fix", "Original report text", "report text", 5975))],
    opts,
  );
  expect(r.actions[0]).toEqual({
    kind: "reply-route",
    replyToMessageId: 5975,
    injectText:
      "↩ tg#5975 «[2026-06-12 14:30] report text…»\n[TG from Alex] please fix — reply via tg",
    from: "Alex",
    messageId: 9,
  });
  expect(r.actions[1]).toEqual({ kind: "ack", messageId: 9 });
});

test("reply whose text is a /command runs the command, not a quote forward", () => {
  const m = reply("/stop", "Original", undefined);
  const r = stepUpdates([upd(2, m)], opts);
  expect(r.actions[0]).toEqual({ kind: "inject-key", key: "Escape" });
});

test("a plain (non-reply) message has no anchor at all — format is unaffected", () => {
  const m: TgMessage = {
    message_id: 11,
    from: { id: CHAT_ID, first_name: "Alex" },
    chat: { id: CHAT_ID },
    date: NOW,
    text: "no reply here",
  };
  const r = stepUpdates([upd(3, m)], opts);
  const injected = r.actions.find((a) => a.kind === "inject-text") as Extract<
    (typeof r.actions)[number],
    { kind: "inject-text" }
  >;
  expect(injected.text).not.toContain("↩");
  expect(injected.text).toBe("[TG from Alex] no reply here — reply via tg");
});
