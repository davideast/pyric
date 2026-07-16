---
title: Run Firebase AI Logic locally
navLabel: Run AI Logic locally
outcome: Keep Firebase AI Logic application code unchanged while model responses stay deterministic or come from a local model.
status: draft
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

Keep scripted setup outside application code that ships. Pyric also supports an OpenAI-compatible local engine through the `engine` option and the `pyric dev` AI proxy. This can connect the same Firebase AI Logic calls to Ollama or another local server. The [AI chat example](https://github.com/davideast/pyric/tree/main/examples/ai-chat) shows both engines with streaming, chat history, and function calling.

Local engines do not reproduce model quality, safety policy, latency, quotas, billing, or service availability. Verify model-dependent behavior against the production backend before release.

## Check the supported boundary

Read the generated [AI Logic conformance matrix](../../../../packages/pyric/docs/ai/COMPAT.md) for the mirrored API, verified wire behavior, documented differences, unsupported APIs, and unverified rows.

Continue with [Inspect and correct](../observe/see-whats-happening.md) or [ship unchanged](../ship/ship-to-production.md).
