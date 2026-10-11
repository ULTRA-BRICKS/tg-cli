// A scripted stand-in for the Anthropic Messages API, so the REAL `claude` binary
// can be driven to a Bash permission prompt without an account login (tg-cli#283).
// Claude Code takes ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY; this server answers its
// requests with the tool calls listed in scenarios.json. The model is scripted —
// the permission box on screen is drawn by Claude Code itself, which is the only
// thing the captures are evidence of.
//
// A request whose first user message contains SCENARIO:<name> and that offers the
// Bash tool gets the scenario's next step as a tool_use (one step per tool_result
// already in the conversation); every other request gets the text "done".
interface Step {
  command: string;
  description?: string;
}
interface ContentPart {
  type: string;
  text?: string;
}
interface Message {
  content: string | ContentPart[];
}
interface MessagesRequest {
  stream?: boolean;
  messages?: Message[];
  tools?: { name: string }[];
}
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: 'Bash'; input: Step };

const here = import.meta.dir;
const scenarios: Record<string, Step[]> = JSON.parse(await Bun.file(`${here}/scenarios.json`).text());

const firstText = (m: Message | undefined): string =>
  typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((c) => c.text ?? '').join(' ');

function streamed(blocks: Block[], stopReason: string): Response {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const usage = { input_tokens: 10, output_tokens: 1 };
  let body = ev('message_start', {
    message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'scripted', content: [], stop_reason: null, stop_sequence: null, usage },
  });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      body += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      body += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else {
      body += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      body += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    body += ev('content_block_stop', { index });
  });
  body += ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage });
  body += ev('message_stop', {});
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 18283),
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method !== 'POST' || !path.startsWith('/v1/messages')) return Response.json({});
    if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 });
    const body = (await req.json()) as MessagesRequest;
    const messages = body.messages ?? [];
    const name = firstText(messages[0]).match(/SCENARIO:(\w+)/)?.[1];
    const steps = name ? scenarios[name] : undefined;
    const offersBash = (body.tools ?? []).some((t) => t.name === 'Bash');
    const done = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'tool_result').length;
    const step = offersBash && steps ? steps[done] : undefined;
    const blocks: Block[] = step
      ? [{ type: 'tool_use', id: `toolu_${name}_${done}`, name: 'Bash', input: step }]
      : [{ type: 'text', text: 'done' }];
    const stop = step ? 'tool_use' : 'end_turn';
    if (body.stream) return streamed(blocks, stop);
    return Response.json({ id: 'msg_scripted', type: 'message', role: 'assistant', model: 'scripted', content: blocks, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
  },
});
process.stdout.write('fake api up\n');
