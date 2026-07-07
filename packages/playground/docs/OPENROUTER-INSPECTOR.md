# OpenRouter call inspector

A runtime surface for answering one question precisely: **"When I pick a
reasoning effort, what is actually sent to OpenRouter, and where does the time
go?"** Built because the symptom — *"no matter what thinking/effort level I set,
it's slow"* — can't be settled by reading code. The effort path is correct on
every static hop (see "Why the code looks fine" below); only the live request
reveals the truth.

## Files

- `src/lib/llm/inference/openrouter-inspect.ts` — wraps `window.fetch`, captures
  the **literal** OpenRouter request body (the `reasoning` param) and tees the
  SSE response to time first-byte / first-thinking-token / first-content-token /
  total, plus reasoning vs output token counts. Registers
  `window.__pyric.printOpenRouter()`.
- `src/lib/llm/openrouter.ts` — emits `openrouter_turn` start/end events with the
  **requested** effort, transport, and provider-side stream timing (this also
  covers `server` mode, where the page never sees the OpenRouter fetch).
- Both feed the existing diagnostics ring buffer (`logPage`), installed at page
  load from `PlaygroundPage.tsx`.

## How to use

1. Open the playground, select the **OpenRouter** provider, set a reasoning
   effort in the model picker, and send a prompt.
2. Open DevTools console and run:

   ```js
   __pyric.printOpenRouter()
   ```

3. Read the table. Each row is one OpenRouter request:

   | column | meaning |
   |---|---|
   | `effort→` | the effort the app **requested** for this turn |
   | `wire.reasoning` | the `reasoning` object **literally on the wire** (ground truth) |
   | `ttfbMs` | time to first byte of the response (network / queueing / cold start) |
   | `firstThinkMs` | ms until the first reasoning token streamed back |
   | `firstTextMs` | ms until the first answer token streamed back |
   | `totalMs` | full stream duration |
   | `reasonTok` / `outTok` | reasoning vs completion tokens (from `usage`) |

4. Below the table, **anomalies** are auto-flagged. The three that matter:

   - *requested 'off' but wire reasoning ≠ `{enabled:false}`* → effort is being
     dropped **between the app and the wire** (a real bug — start in
     `openrouter.ts` / the relay provider).
   - *reasoning disabled on the wire yet the model returned reasoning tokens* →
     OpenRouter / the upstream model **ignored the disable** (an upstream bug,
     not ours — but it's the truth you're chasing).
   - *NNNNms total — dominated by reasoning / by time-to-first-byte / spread
     across generation* → tells you whether the latency is the **model
     thinking**, the **network/cold-start**, or just **a long answer**. Only the
     first is fixable with the effort knob.

## Reading the verdict

- `wire.reasoning` changes as you change the picker, and `off` shows
  `{"enabled":false}` → **the effort knob works**; slowness is the model or the
  network, per the anomaly attribution.
- `wire.reasoning` is identical no matter what you pick → **the knob is not
  reaching the wire**; the bug is upstream of the network.
- `reasonTok` stays high even with `off` → the disable isn't honored upstream
  for that model; switch models or accept the floor.

## Scope

- Captures the page-direct (`fallback`) transport — the default. In `server`
  mode the OpenRouter fetch runs inside the Cloud Function, so the **wire body**
  lives in the function logs; the page-side `openrouter_turn` timing still
  applies and still tells you whether thinking dominated.
- Instrumentation is defensive — a parse/tee failure degrades to "no data,"
  never an exception into the inference stream.
- Events share the diagnostics ring buffer; reset with `__pyric.clearLogs()`.

## Why the code looks fine (static trace)

`ModelPicker.onChange` → `setOpenrouterEffort` → `store/llm.ts` (default
`medium`, read fresh per request) → `openrouter.ts` sets
`NormalizedRequest.reasoningEffort` → `@inbrowser/relay` openrouter provider
translates: `off → reasoning:{enabled:false}`, else
`reasoning:{effort, summary:'auto'}`. The `ReasoningEffort` union matches on both
sides. There is no findable plumbing bug — which is exactly why this inspector
exists: to measure what the static read can't prove.
