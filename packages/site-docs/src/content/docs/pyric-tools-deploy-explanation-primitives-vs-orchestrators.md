---
title: "Primitives throw, orchestrators return"
navLabel: "Primitives vs. orchestrators"
group: "pyric-tools / deploy"
section: "Explanation"
order: 72
---
# Primitives throw, orchestrators return

Every public function in `pyric-tools/deploy` is one of two things, and the two report failures differently. Knowing which is which makes the error-handling code make sense.

## The split

**Primitives** map one REST call to one TypeScript function. They throw `AdminApiError` on any non-2xx response.
```ts
await firestore.rules.deploy(scope, source);   // throws on failure
const op = await firestore.indexes.create(scope, entry);  // throws on failure
```
**Orchestrators** chain multiple primitives together and bucket the failures into a coded `Outcome`. They never throw for expected failures.
```ts
const outcome = await firestore.rules.ensure(scope, recipe);
// outcome is { ok: true, status: '…' } or { ok: false, code, message }

const result = await firestore.indexes.deployAll(scope, config);
// result is { ok: true, ... } or { ok: false, code, message, partial }
```
The JSDoc on each implementation marks which it is. The naming pattern is consistent: terse imperative verbs (`fetch`, `deploy`, `create`) for primitives; longer English verbs (`ensure`, `provision`, `deployAll`, `getStatus`) for orchestrators.

## Why this split

Two different consumers want different things, and the two shapes are useful for those different needs.

**Primitive consumers** want fine-grained control:

- They might branch on HTTP status (`400` vs `403` vs `404`).
- They might surface the raw upstream error body to a developer-facing log.
- They want to compose primitives manually into a workflow that doesn't fit any orchestrator we provide.

`AdminApiError` carries `status` and `body`: every signal the upstream API gave us. Throwing it propagates through `await` chains naturally.

**Orchestrator consumers** want a single shape:

- They handle every operation the same way (`if (!result.ok) showError(result.message)`).
- They consume the result inside a UI or an agent step that already has a "did this succeed?" branch.
- They want partial-success information when a batch fails halfway.

`Outcome` gives them all of that. The coded `'permission-denied'` / `'unknown'` codes mean the same thing across every orchestrator, so error-handling code can be polymorphic.

## What an orchestrator does

A typical orchestrator like `firestore.rules.ensure` does five things:

1. Calls one or more primitives.
2. Catches `AdminApiError` and buckets it into a coded `Outcome`.
3. Catches non-`AdminApiError` exceptions and buckets them as `'unknown'`.
4. Adds operation-specific success branches (`'fresh'`, `'merged'`, `'already-configured'`).
5. Adds operation-specific failure codes (`'merge-failed'`, `'invalid-config'`).

The bucketing logic lives in `withResolvedScope` for the common case. Orchestrators that need their own codes wrap the result.

## When to expose a new orchestrator

A new orchestrator is worth adding when:

- It chains 2+ primitives that consumers always call together.
- It needs to surface partial-success information a single primitive can't.
- It maps a well-defined failure (like "marker missing" or "already exists") to a code that's more useful than "the API returned 404".

A new orchestrator is *not* worth adding when:

- It would only rename a primitive call.
- The bucketing it adds is the same as `withResolvedScope` would produce.
- Consumers genuinely want the underlying `AdminApiError.body` and an `Outcome.message: string` would lose information.

The convention errs on the side of keeping the primitive API small. If you're not sure, expose the primitive first and add an orchestrator only when a real consumer needs it.

## Mixing the two

Calling a primitive from inside a `try` inside an orchestrator is normal. Calling a primitive directly when you want exception-based control flow is also normal. The two shapes coexist. They aren't a deprecation path.

What's *not* fine is wrapping a primitive's throw inside a custom orchestrator for the sake of feeling orchestrator-shaped, then re-throwing inside the catch. Either own the bucketing and produce a real `Outcome`, or let the primitive's exception propagate.

## Tool handlers: a third shape

Tool factories produce a third surface: `ToolHandler.execute` returns `{ ok, summary, data }`. This is the agent-facing shape, and it sits on top of whichever underlying call the handler dispatches.

- For handlers backed by orchestrators: `ToolResult.ok` mirrors `Outcome.ok`; `summary` is a one-line message; `data` is the full `Outcome` for narrowing.
- For handlers backed by primitives: the factory wraps the throw in try/catch and surfaces `{ ok: false, summary: e.message }`.

This means a tool handler is essentially "an orchestrator with an `Outcome` widened by one more layer for agent consumption". See [Tool factories](../pyric-tools-deploy-reference-tool-factories/).
