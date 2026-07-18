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

The sandbox can answer through any OpenAI-compatible server — a local [Ollama](https://ollama.com), llama.cpp, anything speaking `/v1/chat/completions` — while your application keeps making unchanged Firebase AI Logic calls. Pass the `engine` option to `getAI`:

```ts
import { getAI } from 'pyric/ai';

const ai = getAI(app, {
  engine: { kind: 'openai', model: 'llama3.2' },
});
```

`engine` is a pyric extension that only the sandbox reads — upstream `firebase/ai` ignores unknown options, so the same call is production-safe. With no `baseUrl`, answering routes through `pyric dev`'s same-origin AI proxy at `/__pyric/ai-proxy`, which forwards to `http://localhost:11434/v1` — a locally running Ollama works with zero CORS setup, no `OLLAMA_ORIGINS`, nothing. Point the proxy at a different server with the `PYRIC_AI_PROXY_UPSTREAM` environment variable on `pyric dev`.

The translation is wire-level: Gemini-shaped requests in, OpenAI-compatible upstream out, Gemini-shaped responses back — so streaming, chat history, and function calling flow through. The [AI chat example](https://github.com/davideast/pyric/tree/main/examples/ai-chat) runs both engines side by side.

Local engines do not reproduce model quality, safety policy, latency, quotas, billing, or service availability. Verify model-dependent behavior against the production backend before release.

## Check the supported boundary

Per-feature support is tracked on the [AI Logic conformance page](ai-compat.md).

Continue with [Inspect and correct](../observe/see-whats-happening.md) or [ship unchanged](../ship/ship-to-production.md).
