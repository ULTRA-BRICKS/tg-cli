# Render corpus: broken tables and leaking HTML tags

Real (anonymised) and reproduced examples behind tickets
[#815](https://git.hyperide.ai/ultrabricks/tg-cli/issues/815) (markdown tables arrive broken) and
[#813](https://git.hyperide.ai/ultrabricks/tg-cli/issues/813) (HTML tags show up literally). Built
2026-10-28 from `main@a2f348a`. Two JSONL files, one object per line:

| File | Rows | What a row is |
|---|---|---|
| `tables.jsonl` | 67 (50 real, 17 synthetic) | a message body that carries (or should carry) a table |
| `html-leaks.jsonl` | 23 (19 real, 4 synthetic) | a message in which the reader saw literal tags/entities, or a code path that produces one |

## `tables.jsonl` fields

- `id` `T001…`; `origin` `real` (seen in the wild) or `synthetic` (minimal reproduction of a context no
  real instance was found for; its outcome was run through the real code).
- `source`: `transcript` (what the agent passed to `tg`, from harness session logs), `mtproto_render`
  (what the owner's Telegram client displayed, read over the owner's MTProto session), `reproduced`.
- `month`, `sender` (the flags/path that sent it), `format_html` (the send used `--format html`).
- `modes`: the contexts/defect classes (`pre_wrapped`, `label_glued_to_header`, `in_code_fence`,
  `in_blockquote`, `in_list`, `html_paragraph_br_joined`, `escaped_pipe`, `pipe_in_code_span`,
  `br_in_cell`, `md_next_to_real_html_table`, `no_leading_pipe`, `alignment_row`, `ragged_rows`,
  `long_cell`, `wide_glyph`, `over_4096_chars`, `raw_pipes_visible_to_reader`, `block_content_in_cell`, …).
- `authored`: the body as written (anonymised); `null` for `mtproto_render` rows.
- `rendered_visible`: the text the reader saw (anonymised); `null` for `transcript` rows.
- `today`: what `pipeTableToHtml` + `detectTableKind` (`features/render/table.ts`) produce for `authored`
  at the build commit: `kind`, `converted`, `tables_out`, `defects` (`html_tags_visible_in_cells`,
  `ragged_or_shifted_columns`, `md_rows_left_raw`, `md_table_not_recognised`,
  `code_fence_leaks_into_output`, `markdown_markup_visible_in_cells`) and the output `html`.
- `expect`: the behaviour the ticket requires. Rows whose expectation says OWNER DECISION or
  "verify on a rich-capable client" depend on an open question in the ticket.

## `html-leaks.jsonl` fields

`id` `L001…`, `class` (`A_msgref_inline_quote`, `A_msgref_excerpt_block`,
`B_authored_markup_sent_as_plain_before_2026-07-02`, `B2_rich_only_tags_in_plain_body_after_2026-07-02`,
`C_prose_mentions_tag_intentional_negative`, `D_card_embeds_html_source`, `E_double_escaped_entity`,
`F_report_field_html_is_escaped_by_design`, `G_prefix_forces_html_escapes_rich_tags`,
`H_pipe_table_in_plain_body_escapes_basic_tag`), `origin`, `month`, `host_authored` (the sender's own
body), `referenced_stored_text` (for class A: the stored markup of the earlier message that the quote
copies), `rendered_visible`, `today_dry_run` (synthetic rows: output of `tg --dry-run` at the build
commit), `why` (code path), `expect`. Class `C` is a NEGATIVE fixture: literal tags that must stay literal.

## Anonymisation

Deterministic and structure-preserving (`scripts` that built it are not part of the repo): every
Latin/Cyrillic word of 3+ letters becomes a pseudo word of the same length and script, digit runs of
4+ become other digits, URLs/hosts become `example.invalid`, IPv4 becomes `192.0.2.1`, attribute values
are replaced, math-styled letters become `x`, secret-shaped strings were removed first (placeholders
look like `[[EMAIL]]`, not like tags). Markup characters, tags, entities, pipes, dashes, fences,
whitespace, emoji and string lengths are kept, so column widths and tag nesting are real.
`tests/py/test_render_corpus.py` checks the schema and that no identifying token survives.

## Coverage and limits

- The owner<->bot chat exists since 2026-04-20; nothing older exists, so "a year" is 6 months here.
- Transcripts cover Claude Code 2026-07-13..10-28, Codex 2026-06-06..07-13, omp only 2026-10 (older omp
  sessions were pruned and are in no backup). Only `tg` calls with a table/tag signal were extracted.
- 1,697 bot messages are rich messages (`sendRichMessage`); over MTProto layer 220 they arrive as
  `MessageMediaUnsupported` without content, so `mtproto_render` rows never include rich messages.
- The live history rows store the caption AFTER table conversion and with no format/route field, so
  they cannot tell authored markup from converted markup (see ticket requirement R9).
