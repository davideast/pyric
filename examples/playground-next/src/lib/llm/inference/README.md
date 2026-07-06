# Inference layer

Thin dispatch shim over the `@inbrowser/relay` package. Every LLM
call is routed to one of two transports:

- **`fallback`** (default) — calls the provider adapter directly from
  the page using
  [`@inbrowser/relay/providers/{gemini,openrouter}`](../../../../../packages/llm-relay/src/providers).
  Simple; needs no server.
- **`server`** (opt-in) — the resumable server stream: POSTs to a
  same-origin Cloud Function that holds the provider connection and
  buffers events into a Firebase Realtime Database job store
  (`@inbrowser/resumable/rtdb`); the page tails via
  `@inbrowser/relay/client`'s reconnecting consumer with offset
  resume. The only transport that survives Android's background
  socket teardown. Toggled via the `resumableServerMode` setting.

Scope is inference only — the sandbox, tool execution, and the rest of
the agent loop stay on the main thread regardless of transport.

## History

The pre-extraction implementation lived entirely in this directory
(`src/lib/llm/inference/` + `src/lib/server/`). The Option C work in
PR #327 proved durability against Cloud Run + RTDB; the extraction
into `@inbrowser/resumable` + `@inbrowser/relay` (PR #329) moved the
reusable parts into shipping packages, leaving this folder as the
playground's dispatch shim.

An even earlier version routed calls through a service worker — that
investigation is documented in
`plans/sw-inference-backgrounding-recovery.md`. The SW process does
survive backgrounding, but the OS severs its upstream socket at the
same ~15–30s ceiling, so the SW bought nothing the page didn't, at a
large complexity cost. Removed in favor of the resumable server
stream.

## Files

- `index.ts` — the dispatch shim. `createInference()` picks
  `fallback` vs `server` per call, based on the `resumableServerMode`
  setting. Both transports yield the same `InferenceEvent` stream.
- `diagnostics.ts` — page-side activity log (localStorage ring +
  `window.__pyric.printSummary()` console dump). Captured in saved
  sessions so a mobile device with no DevTools can get its inference
  log off-device.

The actual upstream HTTP, SSE parsing, retry logic, RTDB storage,
and HTTP route binding all live in the published packages.
