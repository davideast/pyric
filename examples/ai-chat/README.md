# ai-chat

The graduation demo for pyric's AI surface, and the witness artifact for it:
one chat app, written entirely against the upstream `firebase/ai` API, that
runs unchanged under `pyric dev` on two answer engines.

The app imports only `firebase/app` and `firebase/ai`. It uses
`getGenerativeModel`, streaming via `generateContentStream`, multi-turn
history via `ChatSession`, and a function-calling round trip with a
`get_weather` tool. Under `pyric dev` the import map serves the pyric mirror
for those imports; no app code changes.

## Run

From this directory, with the repo built (`bun run build:cli` at the
root):

```sh
node ../../packages/cli/dist/cli/index.js dev --no-open
```

Or, with `@pyric/cli` installed, run `pyric dev`. Open the printed URL
(serve picks a free port).

## The two modes

The engine picker in the header (or the `?engine=` URL param) selects how the
sandbox answers. The app code is identical in both modes; the only
pyric-specific line is the `engine` option passed to `getAI`, which upstream
`firebase/ai` ignores and only sandbox targets read (see the marked block in
`main.js`).

**scripted** (default, `?engine=scripted`): deterministic and zero-network.
A small script answers `hello` with a streamed reply and drives the weather
round trip; any other prompt gets a synthesized wire-true response. No
request ever leaves for `firebasevertexai.googleapis.com` or
`generativelanguage.googleapis.com`. Script entries are consumed once each,
so a second identical prompt falls back to the synthesized default. That is
by design: scripts are ordered queues, like captured fixtures.

**local model** (`?engine=local`, optionally `&model=<name>`): the same app
answered by a real model. Requests go to serve's same-origin
`/__pyric/ai-proxy` route, which forwards to an OpenAI-compatible server,
default upstream `http://localhost:11434/v1` (Ollama; override with
`PYRIC_AI_PROXY_UPSTREAM`). The default model is `qwen3:4b`:

```sh
ollama pull qwen3:4b
```

## What to expect

- Chat: type a message, watch the reply stream in. In scripted mode `hello`
  streams the scripted chunks; in local mode the model answers for real.
- Weather tool demo: the button asks about the weather in Lisbon with a
  `get_weather` tool declared and function calling forced. The model calls
  the tool, the app runs its local stub, threads the `functionResponse` back,
  and renders the model's final answer. The amber monospace bubble is the
  tool round trip.
- Engine choice is fixed per worker: the sandbox broker is created once per
  SharedWorker lifetime, and the worker lives as long as any tab of this app.
  Toggling the engine reloads the page, which restarts the worker when this
  is the only open tab. If a second tab is open, close it first.

## Why this exists

This page is the destination of the AI surface work: the oracle capture app
shape running unchanged under `pyric dev` on the scripted engine, and the
same app answered by a real local model through an OpenAI-compatible server.
The e2e smoke test at
`packages/cli/test/e2e/ai-demo.pw.ts` boots serve on this directory,
drives both modes in a real browser, and asserts the scripted half performs
zero requests to Google AI endpoints.
