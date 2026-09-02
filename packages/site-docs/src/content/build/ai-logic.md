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
const result = await model.generateContent('Summarise this report.');
```

During development, Pyric answers through a local engine instead of a Google AI endpoint. A normal production build runs the same application code through Firebase. Use the [Firebase AI Logic Web guide](https://firebase.google.com/docs/ai-logic/get-started?platform=web) for the application API.

## Start with deterministic responses

With no AI configuration, Pyric uses its built-in scripted engine. It makes no network requests and gives deterministic responses. Tests can queue an exact response through the sandbox-only scripting entry point:

```ts
import { getAI } from 'pyric/ai';
import { script } from 'pyric/ai/scripting';

const ai = getAI(app);
script(ai, [
  {
    match: 'Summarise this report.',
    respond: { text: 'The report is ready for review.' },
  },
]);
```

Keep scripted setup outside application code that ships.

## Use a local model

For Ollama, put the model identifier in `.env.local` at the Vite project root:

```bash
ollama pull qwen3:4b
```

```dotenv
PYRIC_AI_MODEL=qwen3:4b
```

Then restart Vite:

```bash
npm run dev
```

That one variable switches Pyric from the scripted engine to its OpenAI-compatible engine. `PYRIC_AI_MODEL` is the model name Pyric sends to the upstream server. It is also the catch-all mapping when the application requests a Firebase model name such as `gemini-flash-lite-latest`.

Ollama's default OpenAI-compatible base URL is already Pyric's default: `http://localhost:11434/v1`. Start Ollama separately and make sure the selected model is installed.

## Point Pyric at another model server

Set `PYRIC_AI_PROXY_UPSTREAM` only when the model server is somewhere other than the default Ollama URL:

```dotenv
PYRIC_AI_MODEL=minimax-m2.7
PYRIC_AI_PROXY_UPSTREAM=http://localhost:8080/v1
```

The two settings have different jobs:

- `PYRIC_AI_MODEL` selects the model and activates the OpenAI-compatible engine.
- `PYRIC_AI_PROXY_UPSTREAM` selects the server to which Pyric forwards requests. It is an OpenAI-compatible server base URL, not a Firebase endpoint and not a browser URL. Include `/v1` when that server expects it.

Your browser still calls Pyric on the same origin at `/__pyric/ai-proxy`. The Vite server forwards that request to the upstream server's `/chat/completions` endpoint. This server-side hop avoids browser CORS configuration. An upstream URL alone does not select a model or replace the scripted engine, which is why `PYRIC_AI_MODEL` is still required.

The proxy forwards once. It performs no retry and no backoff. When the upstream
answers `429`, that status and its response body go straight to the calling
code, and the Pyric terminal prints the failure along with the `Retry-After`
value the upstream asked for. Deciding whether to wait and try again is the
application's job.

## Set the variables for one command

On macOS, Linux, and other POSIX shells, prefix the same command with both variables:

```bash
PYRIC_AI_MODEL=qwen3:4b \
PYRIC_AI_PROXY_UPSTREAM=http://localhost:11434/v1 \
npm run dev
```

Do not put `&&` before `npm run dev` like this:

```bash
# Wrong: these are unexported shell variables, so Vite does not receive them.
PYRIC_AI_MODEL=qwen3:4b PYRIC_AI_PROXY_UPSTREAM=http://localhost:11434/v1 && npm run dev
```

The prefix form adds the variables to the environment of that `npm run dev` process. The `&&` form completes a shell-only assignment first, then starts npm as a separate command without exporting those values. Use `.env.local` for a durable project configuration; Vite loads it automatically, and it remains ignored by the template's Git configuration.

## Configure the Vite plugin explicitly

Environment variables keep the default `pyric()` configuration small. If a project needs configuration in code, use the equivalent plugin options:

```ts
pyric({
  ai: {
    model: 'qwen3:4b',
    proxyUpstream: 'http://localhost:11434/v1',
  },
})
```

For model-specific routing or a scripted configuration shared by the whole dev server, the advanced `ai.engine` option accepts Pyric's declarative engine configuration. Choose either `ai.model` or `ai.engine`, not both. Explicit plugin options take precedence over Vite-loaded environment variables.

Generation settings such as `maxOutputTokens`, `temperature`, `topP`, `stopSequences`, and JSON response formatting carry over to the OpenAI request. `topK` and `thinkingConfig` have no equivalent and are dropped locally. Local models do not reproduce production model quality, safety policy, latency, quotas, billing, or service availability, so verify model-dependent behaviour against the production backend before release.

## Pass through to production AI models

To evaluate your application against live Google AI or Vertex AI models during development, set `PYRIC_AI_MODE` to `production` in `.env.local`:

```dotenv
PYRIC_AI_MODE=production
```

Or configure the equivalent mode in your Vite plugin options:

```ts
pyric({
  ai: {
    mode: 'production',
  },
})
```

In production mode, Pyric stops intercepting `getAI()` and `getGenerativeModel()` calls with local sandbox responses or same-origin proxies. Instead, requests pass directly through to Google AI and Vertex AI backend endpoints.

### Project configuration requirements

To use production pass-through successfully, your Firebase project configuration must be authorized for live cloud services:

1. **Authorized Project Credentials**: The configuration object passed to `initializeApp({ apiKey: '...', projectId: '...', ... })` in your application must contain a valid production API key and project ID. Sandbox demo project IDs (such as `demo-app`) will fail when contacting production endpoints.
2. **Enabled Cloud APIs**: The Vertex AI API or Google AI Studio API must be enabled in the Google Cloud / Firebase Console for your project.
3. **No Conflicting Proxy Options**: When `mode` is set to `production`, configuring `ai.model` or `ai.engine` is invalid and will throw an error on startup. Because model selection and routing are handled directly by the production Firebase SDK, remove local proxy model overrides when passing through to production.

## Check the supported boundary

Per-feature support is tracked on the [AI Logic conformance page](ai-compat.md).

Continue with [Inspect and correct](../observe/see-whats-happening.md) or [ship unchanged](../ship/ship-to-production.md).
