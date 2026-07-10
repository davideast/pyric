# CDD deltas for the ai surface (tickets #97, #98, #99)

The messaging effort defined the CDD loop (docs/conformance/cdd.md on PR #60)
for a deterministic surface. The ai surface is the first nondeterministic one.
These rulings record what changes and what carries over, resolved under the
autonomy grant on map #92 with owner veto standing.

## The answer-engine seam and scripted authoring (#97)

The broker exposes one seam:

```ts
interface AnswerEngine {
  generateContent(req: GenerateContentRequest, model: string): Promise<WireResponse>;
  streamGenerateContent(req: GenerateContentRequest, model: string): AsyncIterable<WireChunk>;
  countTokens(req: CountTokensRequest, model: string): Promise<CountTokensResponse>;
}
```

Two engines in V1: `scripted` (default) and `openai`.

Scripted authoring rulings:

1. Zero config works. With no script, the engine returns a deterministic
   synthesized response derived from the request, wire-true in shape. Tests
   and demos never hang on missing setup.
2. Scripts are programmatic first: an ordered queue plus matchers
   (substring, regex, or predicate on the request). Fixture files are a
   serve-layer convenience later, not the core primitive.
3. A script entry is either a raw Gemini envelope (an observation's
   `behavior.raw` pastes in directly, captures are the corpus) or a
   shorthand (`text`, `functionCall`, `json`, or a chunk array for
   streaming). One synthesizer expands shorthands into wire-true envelopes
   and owns the shape facts: finishReason STOP, usageMetadata with
   serviceTier, modelVersion, responseId, thoughtSignature minted on
   functionCall parts (ai-error-fncall-missing-thought-signature).
4. Streaming scripts declare chunk boundaries; the engine applies the
   captured framing (CRLF CRLF, data: prefix, finishReason last chunk only,
   usageMetadata every chunk) so authors never hand-write SSE.

## Where the engines live under pyric dev (#98)

1. The broker and engines are in-process with the sandbox, wherever the
   sandbox lives: the serve worker host in the browser, a plain process in
   Node tests. The scripted engine does no I/O anywhere.
2. The openai engine fetches an OpenAI-compatible base URL. Under
   `pyric dev` the browser cannot reach localhost Ollama without CORS
   configuration, so serve exposes a same-origin proxy route
   (`/__pyric/ai-proxy` forwarding to the configured upstream, default
   `http://localhost:11434/v1`); the engine in the worker host targets the
   proxy. In Node the engine fetches the upstream directly. No user ever
   configures OLLAMA_ORIGINS.
3. The worker protocol gains `ai.generateContent`, `ai.streamGenerateContent`
   (chunks over the existing subscription/event mechanism), and
   `ai.countTokens` ops, exactly like `rtdb.*` and `auth.*`.
4. Engine choice and model mapping are per-sandbox config on the ai mirror
   (not SandboxConfig, which stays reserved): what a Gemini model id resolves
   to locally is an explicit mapping with a default catch-all.

## Evidence tiers and divergence under nondeterminism (#99)

1. A third flip tier joins `oracle-backed` and `unit-backed`: `shape-backed`.
   An assertion set that replays an observation's distilled shape facts (key
   sets, enum values, framing) but cannot replay values because production
   output is nondeterministic flips shape-backed. Error envelopes and
   countTokens ARE value-deterministic and flip oracle-backed. Generated
   text is never compared anywhere.
2. Synthesized decoration is a standing `by-design` divergence class:
   the sandbox mints safetyRatings, token counts, modelVersion, responseId,
   thoughtSignature without running classifiers or tokenizers. Documented
   per row, never hidden.
3. The installed 2.12.0 `sendMessageStream` duplicate-user-turn bug (fixed
   upstream in 2.13.0) is NOT reproduced. The mirror implements the fixed
   semantics and records a `by-design` divergence against the installed
   pin: reproducing a known upstream bug harms the developer the sandbox
   exists for.
4. Model-name volatility is expected drift: re-captures on `-latest`
   aliases may change messageText and modelVersion facts. Drift diffs on
   ai-* observations are reviewed, never auto-failures (messaging drift
   ruling carries over, amplified).
5. Everything else carries over unchanged: rows born unverified, red suite
   derived before implementation, flips ride the PR that makes the
   assertions pass, assertions never weakened, non-blocking climb lane,
   COMPAT publishes at zero, graduation is behavioral, main-branch velocity
   costs nothing (pyricUnreleasedExports).
