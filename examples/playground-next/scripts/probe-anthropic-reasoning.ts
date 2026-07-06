/**
 * One-off probe (Bun) — capture the REAL OpenRouter response shape for
 * Anthropic reasoning + tool calls, and verify reasoning_details
 * round-trip acceptance. Budgeted: exactly TWO requests against
 * anthropic/claude-haiku-4.5 with tiny token caps.
 *
 *   bun examples/playground-next/scripts/probe-anthropic-reasoning.ts
 *
 * Writes raw captures to /tmp/anthropic-probe-{1,2}.json. NOT part of
 * the build; safe to delete.
 */
const key = process.env.OPEN_ROUTER_API_KEY;
if (!key) throw new Error('OPEN_ROUTER_API_KEY not set');

const MODEL = 'anthropic/claude-haiku-4.5';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_price',
      description: 'Get the current menu price for an item id',
      parameters: {
        type: 'object',
        properties: { itemId: { type: 'string' } },
        required: ['itemId'],
      },
    },
  },
];

async function call(body: unknown, label: string) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  await Bun.write(`/tmp/anthropic-probe-${label}.json`, text);
  console.log(`--- ${label}: HTTP ${res.status}, ${text.length} bytes -> /tmp/anthropic-probe-${label}.json`);
  return { status: res.status, text };
}

// Probe 1: streaming, reasoning effort low + small max_tokens, tool offered.
const req1 = {
  model: MODEL,
  messages: [
    { role: 'user', content: 'Check the current price of item "burger-1" using the tool, then answer whether $5 matches.' },
  ],
  tools,
  tool_choice: 'auto',
  stream: true,
  usage: { include: true },
  max_tokens: 2048,
  reasoning: { effort: 'low' },
};
const r1 = await call(req1, '1-stream');

// Parse the SSE: reconstruct message-level fields to see exactly which
// delta fields carry reasoning + signatures.
interface Merged {
  reasoningChunks: string[];
  reasoningDetails: unknown[];
  toolCalls: Record<number, { id?: string; name?: string; args: string }>;
  usage?: unknown;
  text: string;
}
const merged: Merged = { reasoningChunks: [], reasoningDetails: [], toolCalls: {}, text: '' };
const deltaKeys = new Set<string>();
for (const line of r1.text.split('\n')) {
  if (!line.startsWith('data: ')) continue;
  const payload = line.slice(6);
  if (payload === '[DONE]') break;
  let evt: any;
  try { evt = JSON.parse(payload); } catch { continue; }
  const delta = evt.choices?.[0]?.delta;
  if (delta) for (const k of Object.keys(delta)) deltaKeys.add(k);
  if (delta?.content) merged.text += delta.content;
  if (delta?.reasoning) merged.reasoningChunks.push(delta.reasoning);
  if (Array.isArray(delta?.reasoning_details)) merged.reasoningDetails.push(...delta.reasoning_details);
  if (Array.isArray(delta?.tool_calls)) {
    for (const d of delta.tool_calls) {
      const slot = (merged.toolCalls[d.index] ??= { args: '' });
      if (d.id) slot.id = d.id;
      if (d.function?.name) slot.name = d.function.name;
      if (d.function?.arguments) slot.args += d.function.arguments;
    }
  }
  if (evt.usage) merged.usage = evt.usage;
}
console.log('delta keys seen:', [...deltaKeys]);
console.log('reasoning text chars:', merged.reasoningChunks.join('').length);
console.log('reasoning_details raw delta entries:', merged.reasoningDetails.length);
console.log('reasoning_details sample:', JSON.stringify(merged.reasoningDetails.slice(0, 3), null, 1).slice(0, 1200));
console.log('reasoning_details LAST entries:', JSON.stringify(merged.reasoningDetails.slice(-2), null, 1).slice(0, 1200));
console.log('tool calls:', JSON.stringify(merged.toolCalls));
console.log('usage:', JSON.stringify(merged.usage, null, 1));

// Merge reasoning_details deltas by index (concat text, keep last signature/id/format).
const byIndex = new Map<number, any>();
let fallbackIdx = 0;
for (const d of merged.reasoningDetails as any[]) {
  const idx = typeof d.index === 'number' ? d.index : fallbackIdx;
  const slot = byIndex.get(idx) ?? { ...d, text: '' };
  if (typeof d.text === 'string') slot.text = (slot.text ?? '') + d.text;
  if (typeof d.data === 'string') slot.data = (slot.data ?? '') + d.data;
  if (d.signature) slot.signature = d.signature;
  if (d.id) slot.id = d.id;
  if (d.format) slot.format = d.format;
  if (d.type) slot.type = d.type;
  byIndex.set(idx, slot);
  fallbackIdx = idx;
}
const mergedDetails = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => {
  const { index: _i, ...rest } = v;
  return rest;
});
console.log('merged reasoning_details:', JSON.stringify(mergedDetails.map((d: any) => ({ ...d, text: typeof d.text === 'string' ? `${d.text.slice(0, 60)}… (${d.text.length} chars)` : d.text, signature: d.signature ? `${String(d.signature).slice(0, 24)}… (${String(d.signature).length} chars)` : undefined })), null, 1));

const tc = Object.values(merged.toolCalls)[0];
if (!tc?.id || !tc?.name) {
  console.log('NO TOOL CALL in probe 1 — probe 2 skipped (shape capture still useful)');
  process.exit(0);
}

// Probe 2: echo assistant turn WITH reasoning_details + tool result; expect 200.
const req2 = {
  model: MODEL,
  messages: [
    req1.messages[0],
    {
      role: 'assistant',
      content: merged.text || null,
      tool_calls: [{ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args || '{}' } }],
      reasoning_details: mergedDetails,
    },
    { role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ itemId: 'burger-1', price: 5 }) },
  ],
  tools,
  tool_choice: 'auto',
  stream: false,
  usage: { include: true },
  max_tokens: 1024,
  reasoning: { effort: 'low' },
};
const r2 = await call(req2, '2-roundtrip');
try {
  const j = JSON.parse(r2.text);
  const m = j.choices?.[0]?.message;
  console.log('probe2 message keys:', m ? Object.keys(m) : null);
  console.log('probe2 text:', (m?.content ?? '').slice(0, 200));
  console.log('probe2 reasoning_details count:', Array.isArray(m?.reasoning_details) ? m.reasoning_details.length : 'none');
  console.log('probe2 usage:', JSON.stringify(j.usage, null, 1));
} catch (e) {
  console.log('probe2 parse failed:', e);
}
