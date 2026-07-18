---
title: "Run Firebase AI Logic locally"
navLabel: "AI Logic"
group: "Build"
section: ""
order: 60
description: "Keep Firebase AI Logic application code unchanged while model responses stay deterministic or come from a local model."
---

# Run Firebase AI Logic locally

Keep using the Firebase AI Logic Web API:
```ts
import { getAI, getGenerativeModel } from 'firebase/ai';

const ai = getAI(app);
const model = getGenerativeModel(ai, {
  model: 'gemini-flash-lite-latest',
});
const result = await model.generateContent('Summarize this report.');
```
During development, Pyric answers through a local engine instead of a Google AI endpoint. A production build runs the same application code through Firebase. Use the [Firebase AI Logic Web guide](https://firebase.google.com/docs/ai-logic/get-started?platform=web) for normal model, prompt, chat, streaming, schema, and function-calling APIs.

## Choose how the sandbox answers

The default scripted engine is deterministic and makes no network requests. Test setup can queue an exact response through the sandbox-only scripting entry point:
```ts
import { getAI } from 'pyric/ai';
import { script } from 'pyric/ai/scripting';

const ai = getAI(app);
script(ai, [
  {
    match: 'Summarize this report.',
    respond: { text: 'The report is ready for review.' },
  },
]);
```
Keep scripted setup outside application code that ships.

## Answer with a real local model (Ollama)

The sandbox can answer through any OpenAI-compatible server — a local [Ollama](https://ollama.com), llama.cpp, anything speaking `/v1/chat/completions` — while your application keeps making unchanged Firebase AI Logic calls. Pass the `engine` option on the app's own `getAI` call from `firebase/ai`, the handle the application actually queries, so the setting reaches the code that answers:

```ts
import { getAI, type AIOptions } from 'firebase/ai';

const ai = getAI(app, {
  engine: { kind: 'openai', model: 'llama3.2' },
} as AIOptions);
```

The first `getAI` call for an app decides its engine; later calls with different options are ignored, so configure it where the app first creates its AI handle.

`engine` is a pyric extension that only the sandbox reads. At runtime, production `firebase/ai` ignores the extra option; in TypeScript, `AIOptions` has no `engine` member, so a typed build needs the options object cast — the `as AIOptions` above — or the engine kept in a development-only branch.

With no `baseUrl`, answering routes through `pyric dev`'s same-origin AI proxy at `/__pyric/ai-proxy`, which forwards to `http://localhost:11434/v1` — a locally running Ollama works with zero CORS setup, no `OLLAMA_ORIGINS`, nothing. Point the proxy at a different server with the `PYRIC_AI_PROXY_UPSTREAM` environment variable on `pyric dev`.

Use `modelMap` to send specific Gemini model ids to specific upstream models; `model` stays the catch-all for anything unmatched.

```ts
engine: { kind: 'openai', modelMap: { 'gemini-2.5-flash': 'llama3.2' } }
```

`maxOutputTokens`, `temperature`, `topP`, `stopSequences`, and JSON response formatting carry over to the OpenAI request. `topK` and `thinkingConfig` have no equivalent and are dropped in development, though production still honors them. When a local thinking model returns its reasoning, it surfaces as thought parts.

Gemini-shaped requests go out as OpenAI-compatible ones and come back Gemini-shaped, so streaming, chat history, and function calling all flow through. The [AI chat example](https://github.com/davideast/pyric/tree/main/examples/ai-chat) runs both engines side by side.

Local engines do not reproduce model quality, safety policy, latency, quotas, billing, or service availability. Verify model-dependent behavior against the production backend before release.

## Check the supported boundary

Per-feature support is tracked on the [AI Logic conformance page](ai-compat.md).

Continue with [Inspect and correct](../observe/see-whats-happening.md) or [ship unchanged](../ship/ship-to-production.md).
