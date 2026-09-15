# Inspect AI Logic activity

Open the runtime chip, select **Traffic → Rates → AI Logic**. The same timeline controls as the other services let you pause, scrub, zoom, and save a capture. **Model requests** expands the retained request details; measurement definitions stay under **How measurements work** in the Measurements view.

## What the measurements mean

Started counts requests when they begin; Completed counts successful responses when they finish. Failures count failed outcomes, and In progress shows requests currently awaiting an outcome. Requests include `generateContent`, `generateContentStream`, and `countTokens`, including their chat entry points and failed attempts. A streaming generation is one request. Consuming its chunks creates Flow render signals without adding requests or token usage. Duration measures client elapsed time through completion, and first-chunk time measures the first received envelope—not necessarily the first text token.

Generation token totals use final response usage. Backend-reported input and output tokens are separate from locally estimated or scripted totals. Unknown usage is counted explicitly. `countTokens` reports its count in request details but never adds those tokens to generation usage. These measurements cover this page, not a project’s bill. Scripted fixtures invoke no real model.

Aggregate counters are independent of the request-detail list. Details retain up to 100 requests, including pending requests; the timeline retains up to 30 minutes. Pausing freezes its browsable range while recording continues. Automatic idle selection includes the associated request duration. A manually selected completion-only period can contain tokens and a completion without a start. Captures retain the selected measurements and the request identity available at capture time.

## Identify aliases and local models

Request details distinguish:

- **Requested as:** the model identifier used by application code.
- **Routed to:** the configured target, such as a `modelMap` entry or catch-all local model.
- **Reported model:** the identifier returned by the backend, when available.
- **Backend:** the engine and credential-free endpoint origin.

Routing is captured when a request begins; changing a mapping does not rewrite older requests. A backend’s reported model is a claim, not independent verification of its weights. Synthesized Gemini-style model versions are never shown as proof that Gemini handled a local or scripted request. Proxy origins alone do not establish whether the upstream is local.

For example, an existing engine configuration can route an application’s Gemini alias to Ollama:

```ts
const ai = getAI(sandbox, {
  engine: {
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    modelMap: { 'gemini-2.5-flash': 'qwen3:8b' },
  },
});
const model = getGenerativeModel(ai, { model: 'gemini-2.5-flash' });
await model.generateContent('Summarize this discussion.');
```

The requested alias remains `models/gemini-2.5-flash`; routing shows `qwen3:8b`. Reported identity and tokens depend on what the upstream actually returns.

## Configure warnings

Use the service’s existing settings control, or the `runtime.thresholds` section in `pyric.json`:

```json
{
  "runtime": {
    "thresholds": {
      "sustainedSeconds": 5,
      "ai": {
        "requests": 2,
        "inputTokens": 2000,
        "outputTokens": 500
      }
    }
  }
}
```

These defaults are per-page investigation thresholds, not provider quotas. At a sustained rate, they correspond to 120 requests, 120,000 input tokens, or 30,000 output tokens per minute. Token thresholds use backend-reported generation tokens only; estimates and scripted totals do not trigger them. Set a limit to `null` to disable it. The existing incident recovery, review, and capture behavior applies.

## Try the example

```sh
bun examples/runtime-flow-lab/serve.ts
```

The **AI Logic** section provides Generate, Stream, Fail request, and Rate warning controls. Scripted mode works offline. Select **Local OpenAI-compatible** to discover the configured server’s available models, then choose one from **Local model**. **Refresh models** picks up newly installed models. Discovery and generation use the development server, including when the page is opened over Tailscale. Its upstream defaults to `http://localhost:11434/v1`; override it with `FLOW_LAB_AI_UPSTREAM` when starting the example. The failure and burst scenarios require Scripted mode.

In **Data**, select **Flow** to see React renders observed after responses or consumed chunks. This is timing correlation, not proof of a data dependency.

No CLI commands or MCP tools are added. Existing capture save/list/open tools accept AI Logic captures, and the runtime threshold configuration gains the `ai` section. Internal worker messages carry diagnostic identity separately from the Firebase response and error surfaces. Prompts, generated text, credentials, and request payloads are not retained by these counters or request details.

`countTokens` on the OpenAI-compatible engine runs a local estimate. Its details name the configured route for context but explicitly say no model was invoked.
