# Firebase AI Logic audit

Read this reference when the application imports `firebase/ai` or `pyric/ai`, configures a Pyric AI engine, or sends model requests through Firebase AI Logic.

## Build the inventory

Record:

- every `getAI`, `getGenerativeModel`, `generateContent`, streaming, token-counting, chat, and tool/function-calling site
- the Firebase app and backend/provider configuration used to initialize AI Logic
- requested model names and any Pyric model mapping
- generation settings, response schemas, system instructions, tool declarations, and safety settings
- where prompts receive user content, Firestore/RTDB data, uploaded files, authentication context, or secrets
- where model output reaches the UI, a database write, a Function, another tool, or an authorization-sensitive decision
- loading, cancellation, retry, timeout, partial-stream, quota, blocked-response, malformed-response, and offline behavior
- deterministic fixtures or scripted responses that cover the main success and failure paths

Keep prompt contents, credentials, customer data, and model responses out of findings and plans. Cite the call site and describe the data class.

## Identify the active Pyric mode

Use code, environment-key names, and the installed `@pyric/cli` implementation to determine the mode. Do not infer it from a model name.

| Mode | Signals | Audit meaning |
|---|---|---|
| Scripted sandbox | No AI override, or `ai.engine.kind: 'scripted'`; tests may call `script()` from `pyric/ai/scripting` | Deterministic, local, and no model network request |
| OpenAI-compatible sandbox | `ai.model`, `ai.engine.kind: 'openai'`, or `PYRIC_AI_MODEL`; optional `ai.proxyUpstream` or `PYRIC_AI_PROXY_UPSTREAM` | Pyric intercepts Firebase AI calls and routes them through the configured engine or same-origin proxy |
| Production pass-through | `ai.mode: 'production'` or `PYRIC_AI_MODE=production` | Pyric leaves Firebase AI calls connected to Google AI or Vertex AI endpoints |

Treat a non-loopback proxy upstream as external network activity even when the Pyric mode is `sandbox`. Do not call it during a normal audit.

Explicit Vite plugin options take precedence over Vite-loaded environment variables. `ai.model` and `ai.engine` are mutually exclusive. Production mode cannot be combined with either of them. An upstream URL by itself does not select an OpenAI-compatible model.

`PYRIC_AI_PASSTHROUGH=1` may appear in projects built against a compatibility path. Report it and confirm behavior against the installed CLI. Prefer `PYRIC_AI_MODE=production` in new plans.

## Audit the local path

Use the scripted engine for repeatable request-plumbing and UI-state checks. Cover:

1. a normal response
2. a blocked, rejected, or thrown response
3. malformed structured output when the application expects a schema
4. a partial or interrupted stream when streaming is used
5. duplicate submission, retry, or navigation while a request is active

An already running loopback model can show that the proxy and application integration work. Record the exact engine and model because its output is nondeterministic. Never turn a local-model response into a claim about production quality.

Check that scripted setup stays in test or sandbox-only code. Application code should continue to use the Firebase AI Logic API so a normal production build can use Firebase.

## Audit the production boundary

Inspect production configuration without enabling pass-through:

- the application has a real Firebase project ID and API key for the intended environment; demo identifiers cannot reach live AI services
- the release process enables the required Google AI or Vertex AI service outside the repository
- local model, proxy, and scripted settings do not leak into the production command or artifact
- production mode has no `ai.model` or `ai.engine` conflict
- App Check, abuse controls, authentication, and per-user limits match the application's exposure
- prompts exclude secrets and unnecessary personal data
- model output is validated before database writes, tool calls, navigation, or other consequential actions
- failures have a user-visible fallback and bounded retries
- the team has explicit cost, quota, latency, and availability expectations

The Firebase web API key and project configuration normally ship to the browser. Look for unrestricted non-Firebase credentials or server secrets instead of reporting the Firebase config itself as a leak.

## State what the evidence covers

Source inspection can establish configuration and data flow at E0. A deterministic scripted request observed in the isolated sandbox can establish that exact application path at E2. An already configured loopback model can establish local proxy wiring at E2.

Pyric's local AI path cannot establish production model quality, safety policy, latency, quota, billing, regional behavior, or cloud availability. It also cannot show that a cloud API is enabled without an authorized production observation. List these gaps under **Production readiness & regression safety**.

Map authorization and sensitive-data findings to **Authorization & identity** or **Data integrity & model fit**. Map request lifecycle, validation, retries, and side effects to **Runtime behavior & side effects**. Map mode conflicts, build leakage, missing production prerequisites, and local-only confidence to **Production readiness & regression safety**.
