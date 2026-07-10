# Prototype: OpenAI-to-Gemini translator (ticket #96)

Throwaway prototype that resolved wayfinder ticket #96: does OpenAI-to-Gemini
translation hold up against a real local model, and where are the lossy edges?

Verdict: feasible. The REAL `firebase/ai` 2.12.0 SDK, pointed at `server.ts`
via `RequestOptions.baseUrl`, ran the full matrix (text, streaming, chat,
function calling, structured output, thinking) against local Ollama models
faithfully. Full results and judgment on the ticket:
https://github.com/davideast/pyric/issues/96

This code is reference material for the AI broker's OpenAI engine, not
product code: no tests run in CI, nothing imports it. `translator.ts` is the
liftable core (request/response/stream-chunk/error translation, SSE framing).

Run: `bun server.ts` (Ollama on :11434), then `bun tests.ts`.

Lossy edges found (details in ticket):
- Gemini functionResponse has no tool_call_id: synthesized FIFO id matching.
- OpenAI streams tool-call argument fragments; Gemini streams whole
  functionCall parts: a broker must buffer and emit whole.
- topK and thoughtSignature have no OpenAI equivalent: dropped.
- Never forward OpenAI's `data: [DONE]` sentinel: the SDK JSON.parses every
  event and dies with PARSE_FAILED.
- Thought parts must be skipped when replaying history to OpenAI.
