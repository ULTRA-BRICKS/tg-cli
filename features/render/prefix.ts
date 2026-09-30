// --- Message prefix (branded emoji + styled [window] + optional tag/title) ---
//
// Extracted from the `tg` entrypoint (decomposition Stage 1, docs/specs/
// tg-decomposition.md). The main()-side closure captured AI_EMOJI / MODEL /
// the resolved tmux window name; here they arrive as explicit params. The
// returned shape is unchanged: `html` (custom emoji → <tg-emoji>, window name →
// Mathematical Sans-Serif Bold or an escaped <b> fallback) and `plain` (unicode
// only, no tags), plus `forceHtml` (true when the html form carries a real tag,
// so the whole message MUST go out as HTML) and `present`.
//
// The prefix ALWAYS ends with a newline: the message body sits BELOW the header
// line, never joined onto it. The header line is `✳️ [window]`, optionally
// followed by an `[agent]` bracket (subagent identification, tg#6254), an
// explicit tag badge, and/or an explicit `--title`. `[agent]` reuses the SAME
// styling as `[window]` (styleWindowName) — just another bracketed label:
//   ✳️ [window]                          (no agent, no tag, no title)
//   ✳️ [window] [agent]                  (--subagent / TG_AGENT / RIG_AGENT_ID subagent)
//   ✳️ [window] <title>                  (--title only)
//   ✳️ [window] 🔵 ANSWER               (--tag only, unicode fallback)
//   ✳️ [window] [agent] 🔵 ANSWER — <title>  (agent + tag + title, all compose)
// The message body NEVER rides this line — only an explicit tag/title appear.
import { EMBEDDABLE_EMOJI_MAP, SUBSTRING_FALLBACK_EXCLUDED_KEYS, extractBaseModel, hasRealPillIds, TAG_PILL_IDS } from '../branding/emoji';
import { styleTaskTitle, styleWindowName, toBoldItalic } from '../prefix-style/style';
import { resolveTag } from './tag';
import { escapeHtml } from './html';

export interface PrefixParts {
  html: string;
  plain: string;
  present: boolean;
  forceHtml: boolean;
}

export function buildPrefix(opts: {
  aiEmoji: string;
  model: string;
  tmuxWindow: string;
  // SUBAGENT label (`--subagent <name>` / `TG_AGENT` / the launcher's `RIG_AGENT_ID`,
  // resolved by features/agent-role). Rendered as its own bracket right after
  // `[window]`, styled identically (styleWindowName) — see the header-shape table
  // above. The MAIN agent passes nothing and gets no second bracket.
  agentLabel?: string;
  // Explicit message tag (`--tag`). The CLI validates this to a lowercase-english
  // word (answer/decision/problem/report) before it reaches here; resolveTag
  // uppercases + resolves it. The renderer itself stays total — an off-list value
  // would render a plain `[TAG]` badge — but the CLI never passes one.
  tag?: string;
  // Explicit header title (`--title`). The message body is NEVER pulled up
  // here; only this explicit title ever appears on the header line.
  title?: string;
}): PrefixParts {
  const { aiEmoji, model, tmuxWindow, agentLabel, tag, title } = opts;
  let html = '';
  let plain = '';
  let forceHtml = false;

  if (aiEmoji) {
    // Resolve the branded custom-emoji id (exact key, then substring match —
    // minus the SUBSTRING_FALLBACK_EXCLUDED_KEYS: 'computer-use-preview'
    // contains 'omp' but must NOT pick up its branded id).
    const base = extractBaseModel(model);
    // typeof guard, not truthiness: prototype keys ('constructor', …) are
    // truthy non-strings on a plain object map and must fall through.
    const exactId: unknown = EMBEDDABLE_EMOJI_MAP[base];
    let emojiId = typeof exactId === 'string' ? exactId : undefined;
    if (!emojiId) {
      for (const [key, id] of Object.entries(EMBEDDABLE_EMOJI_MAP)) {
        if (SUBSTRING_FALLBACK_EXCLUDED_KEYS.has(key)) continue;
        if (base.includes(key)) {
          emojiId = id;
          break;
        }
      }
    }
    if (emojiId) {
      html += `<tg-emoji emoji-id="${emojiId}">${aiEmoji}</tg-emoji>`;
      forceHtml = true; // a custom-emoji tag only renders in HTML mode
    } else {
      html += escapeHtml(aiEmoji); // no branded id → plain unicode emoji
    }
    plain += aiEmoji;
  }

  if (tmuxWindow) {
    if (plain.length > 0) {
      html += ' ';
      plain += ' ';
    }
    const styled = styleWindowName(tmuxWindow);
    html += `[${styled.html}]`;
    plain += `[${styled.plain}]`;
    if (styled.tag) forceHtml = true; // the <b> Cyrillic fallback forces HTML
  }

  // --- Optional subagent label (`--subagent` / env signals) right after [window]. ---
  // Same bracket styling as the window name — it is a sender-identity label,
  // not a differently-branded element, so it gets no special color/emoji.
  if (agentLabel) {
    if (plain.length > 0) {
      html += ' ';
      plain += ' ';
    }
    const styled = styleWindowName(agentLabel);
    html += `[${styled.html}]`;
    plain += `[${styled.plain}]`;
    if (styled.tag) forceHtml = true; // the <b> Cyrillic fallback forces HTML
  }

  // --- Optional tag badge (`--tag`) on the header line, after [window]. ---
  // Three render paths:
  //   1. Known tag WITH real, uploaded pill ids → the wordmark pill as N
  //      <tg-emoji> cells (premium-only; forces HTML). The plain branch keeps
  //      the unicode fallback so the >4096 splitter / non-HTML path still reads.
  //   2. Known tag WITHOUT real ids (a placeholder set, e.g. while a pill is
  //      being regenerated) → the unicode fallback badge (`🔵 ANSWER`) in BOTH
  //      forms. Every shipped tag has real ids today; the guard stays because a
  //      placeholder id must NEVER be emitted inside a <tg-emoji> tag —
  //      hasRealPillIds ensures a broken/empty emoji can never go out.
  //   3. Unknown tag → a soft `[WORD]` badge (no emoji, no fail) — UNCHANGED.
  if (tag && tag.trim()) {
    const resolved = resolveTag(tag);
    const sep = plain.length > 0 ? ' ' : '';
    if (resolved.known && hasRealPillIds(resolved.word)) {
      // Real pill ids: render each cell as <tg-emoji emoji-id>DOT</tg-emoji>, one
      // per uploaded cell. Telegram REQUIRES the inner (fallback) text of a
      // custom_emoji entity to be exactly one emoji — wrapping a slice of the
      // word ("SWER") is rejected with ENTITY_TEXT_INVALID — and that inner text
      // MUST equal the cell's Telegram-side alt (emoji_list) or Telegram drops
      // the entity. So each cell wraps ITS OWN per-cell dot (resolved.cellDots):
      // cell 0 = the tag's colored dot, cells 1..n-1 = the neutral square. A push
      // notification (rendered by the OS, which can't load the pill image) then
      // shows ONE colored dot + neutrals (e.g. `🔵▫️▫️`) — the color identifies
      // the tag, the rest stay quiet — instead of N loud identical color dots.
      // (CTO 2026-06-15.) Premium clients render the N pill images edge-to-edge
      // into the wordmark chip (which already SPELLS the word — baked into the
      // sticker art), so the HTML header carries ONLY the pill cells — NO appended
      // plain word (CTO 2026-06-14: first line = --title only). The plain form
      // keeps the readable unicode fallback ("🔵 ANSWER") for the non-HTML /
      // >4096 split path, which is the only readable form there.
      const ids = TAG_PILL_IDS[resolved.word];
      const cells = ids
        .map((id, i) => `<tg-emoji emoji-id="${id}">${escapeHtml(resolved.cellDots[i] ?? resolved.dot)}</tg-emoji>`)
        .join('');
      html += `${sep}${cells}`;
      plain += `${sep}${resolved.fallback}`;
      forceHtml = true; // a custom-emoji pill only renders in HTML mode
    } else {
      // Known but placeholder ids / non-premium → unicode fallback badge.
      // Unknown → bare `[WORD]`. Both render identically in html (escaped) and
      // plain; no <tg-emoji>, so a placeholder id can never leak out.
      const badge = resolved.known ? resolved.fallback : `[${resolved.word}]`;
      html += `${sep}${escapeHtml(badge)}`;
      plain += `${sep}${badge}`;
    }
  }

  // --- Optional explicit title (`--title`) on the header line. ---
  // Styled like the autolink single-ticket title (Bold Italic) for visual
  // consistency. A Cyrillic/foreign title falls back to <i> in HTML (forcing
  // HTML); the plain form keeps the unstyled raw text.
  if (title && title.trim()) {
    const raw = title.trim();
    // With a tag present the title follows ` — `; otherwise just a space.
    const hasTag = !!(tag && tag.trim());
    const sep = plain.length > 0 ? (hasTag ? ' — ' : ' ') : '';
    html += `${sep}${styleTaskTitle(raw)}`;
    plain += `${sep}${toBoldItalic(raw) ?? raw}`;
    // styleTaskTitle wraps a foreign-letter title in <i> → must go out as HTML.
    if (toBoldItalic(raw) === null) forceHtml = true;
  }

  if (!plain && !html) return { html: '', plain: '', present: false, forceHtml: false };
  // The prefix ALWAYS ends with a newline: the body sits BELOW the header line.
  // The body's first line is NEVER joined onto `[window]` (only an explicit
  // --tag/--title ever appears on the header line, handled above).
  return { html: html + '\n', plain: plain + '\n', present: true, forceHtml };
}
