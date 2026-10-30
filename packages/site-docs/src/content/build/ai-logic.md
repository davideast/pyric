---
title: "Run Firebase AI Logic locally"
navLabel: "AI Logic"
group: "Build"
section: ""
order: 60
description: "Keep Firebase AI Logic application code unchanged while model responses stay deterministic or come from a local model."
---

# Run Firebase AI Logic locally

Keep using the Firebase AI Logic Web API, with App Check initialized first. During development, Pyric answers through a local engine instead of a Google AI endpoint. A normal production build runs the same application code through Firebase. Use the [Firebase AI Logic Web guide](https://firebase.google.com/docs/ai-logic/get-started?platform=web) for the application API.

## Initialize App Check before getAI

From November 2, 2026, Firebase AI Logic requires App Check: a request without an App Check token gets a 403. `getAI` reads App Check when it starts, so call `initializeAppCheck` before `getAI`, synchronously, with a static import. A model created before App Check sends no token.

```ts
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import { getAI, getGenerativeModel } from 'firebase/ai';

if (import.meta.env.DEV) {
  const scope = self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string };
  scope.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}
initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider('your-recaptcha-v3-site-key'),
  isTokenAutoRefreshEnabled: true,
});

const ai = getAI(app);
const model = getGenerativeModel(ai, {
  model: 'gemini-flash-lite-latest',
});
const result = await model.generateContent('Summarise this report.');
```

Setting `FIREBASE_APPCHECK_DEBUG_TOKEN` in development switches App Check to its debug provider, so local runs need no reCAPTCHA. In the sandbox, Pyric answers App Check locally. In [production AI mode](#pass-through-to-production-ai-models) the Firebase SDK prints a debug token to the browser console; register it in the Firebase console under App Check, Apps, Manage debug tokens, and AI Logic accepts the requests. Get the reCAPTCHA v3 site key for production builds from the same App Check page.

The sandbox refuses these requests too. If an app never calls `initializeAppCheck`, or calls it after `getAI`, `generateContent`, `generateContentStream`, `countTokens` and chat messages fail with the same 403 error production returns. Pyric prints how to fix it in the browser console and in the dev server terminal. Sandbox tokens from `initializeAppCheck` are accepted, with or without the debug provider.

With a `CustomProvider` and no debug token set, the sandbox calls your provider's `getToken` and sends the token it returns, as production does. AI Logic requests then answer only when that token is one the sandbox signed, such as a token your server mints with `firebase-admin` `createToken` under Pyric. A provider that rejects, or returns anything else, gets the same 403 as a request with no token. The sandbox cannot check a token Google signed, so a provider that returns a real App Check token is refused too. Set the debug token in development to skip the provider, as production does.

## Start with deterministic responses

With no AI configuration, Pyric uses its built-in scripted engine. It makes no network requests and gives deterministic responses. Tests can queue an exact response through the sandbox-only scripting entry point:

```ts
import { initializeAppCheck, ReCaptchaV3Provider } from 'pyric/app-check';
import { getAI } from 'pyric/ai';
import { script } from 'pyric/ai/scripting';

initializeAppCheck(app, {
  provider: new ReCaptchaV3Provider('your-recaptcha-v3-site-key'),
  isTokenAutoRefreshEnabled: true,
});
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

`pyric sandbox` runs your command under a network guard that reports connections to live Google endpoints, and refuses them only when you set `PYRIC_GUARD=block`. It permits the AI upstream you configure, from `PYRIC_AI_PROXY_UPSTREAM` or the Vite plugin's `ai` options (`proxyUpstream`, or an engine `baseUrl` on another origin), so an upstream such as a Vertex AI OpenAI-compatible endpoint stays reachable under `block` too. To permit other hosts, see `PYRIC_GUARD_ALLOW` in the [CLI reference](../reference/cli.md).

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

The plugin option takes precedence over `PYRIC_AI_MODE`.

In production mode, Pyric stops intercepting `getAI()` and `getGenerativeModel()` calls with local sandbox responses or same-origin proxies. `firebase/ai` is the Firebase SDK, and it calls Google AI or Vertex AI with the `apiKey` and `projectId` your app passes to `initializeApp`. The dev server needs no Gemini API key. The startup banner confirms the mode:

```text
✔ [pyric] ai: production passthrough; firebase/ai is the Firebase SDK, calling Google AI or Vertex AI with the app's initializeApp config
```

Production mode works the same way on `pyric sandbox`, on the Vite plugin, and in a Node process started with `node --import @pyric/cli/register`. On `pyric sandbox` without Vite, Pyric builds `firebase/app`, `firebase/ai`, and `firebase/app-check` from your project's own `firebase` package, so install `firebase` in the project first. Without it, `pyric sandbox` stops at startup and says to install it. Upgrading `firebase` rebuilds that bundle on the next start.

The model id you request goes to the backend unchanged. A model the backend does not serve fails with the backend's own error, as it would in production, and `modelVersion` is the value the backend reports. Other Firebase modules, such as `firebase/firestore` and `firebase/auth`, still run against the local sandbox.

In production mode the page's App Check tokens come from Firebase. A server started with `node --import @pyric/cli/register` and `PYRIC_AI_MODE=production` verifies them with `firebase-admin`, so install `firebase-admin` beside the server. Verification fetches Firebase's public keys and uses no credentials, and `verifyToken(token, { consume: true })` is recorded in the server process, not by Firebase. Tokens the sandbox minted still verify. In sandbox AI mode, a token from Firebase is refused with an `app-check/invalid-argument` error that says why.

### Project configuration requirements

To use production pass-through successfully, your Firebase project configuration must be authorized for live cloud services:

1. **Authorized Project Credentials**: The configuration object passed to `initializeApp({ apiKey: '...', projectId: '...', ... })` in your application must contain a valid production API key and project ID. Sandbox demo project IDs (such as `demo-app`) will fail when contacting production endpoints.
2. **Enabled Cloud APIs**: The Vertex AI API or Google AI Studio API must be enabled in the Google Cloud / Firebase Console for your project.
3. **No Conflicting Proxy Options**: When `mode` is set to `production`, configuring `ai.model` or `ai.engine` is invalid and will throw an error on startup. Because model selection and routing are handled directly by the production Firebase SDK, remove local proxy model overrides when passing through to production.

## Check the supported boundary

Per-feature support is tracked on the [AI Logic conformance page](ai-compat.md).

Continue with [Inspect and correct](../observe/see-whats-happening.md) or [ship unchanged](../ship/ship-to-production.md).
