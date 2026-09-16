# Worker AI and service-neutral Traffic checkpoint

Traffic now records AI execution at the shared host boundary. A page adapter is no longer required for a background worker request to appear in the chip or Studio. The same execution record feeds Requests, AI Rates, and Studio's request inspector in both SharedWorker and Node mode.

## Recorded evidence

Each execution has one request ID across its start, progress, and terminal updates. Identity and provenance are captured before execution. Responses retain a text preview of up to 16,384 characters, with credential syntax redacted. Prompts, tool payloads, transport headers, and auth credentials are not recorded by this observer. Errors retain a code, not arbitrary provider error bodies. Model routing, reported identity, timing and token usage remain separate facts; missing measurements are labelled unavailable. Synthetic token estimates do not count as backend usage.

A cancelled stream is labelled Cancelled. A prior session's unfinished request is labelled Interrupted after host recovery; no completion time or successful outcome is inferred. Requests recorded before this change lack this execution evidence and are not backfilled from Activity summaries.

Auth changes that the sandbox records now use the same request inspector. Other service operations retain their existing request/resource evidence and rules inspection. A Firestore rules evaluation is labelled as such, rather than asserting that a later write succeeded.

## History and browsing

Age is measured using the stream’s wall-clock observation time, so a simulated service clock cannot prematurely evict fresh requests. The shared defaults are 30 minutes, 10,000 events, and an 8 MiB history ceiling (`OBSERVATION_HISTORY_LIMITS`). Active requests and active listener registrations are kept separately from evictable history. History gaps remain visible. Response progress is sampled at most five times per second, with terminal evidence always recorded.

The chip starts with 25 requests, supports Load older and service filtering, and pins the list while browsing older requests or inspecting a selection. Resume live reports new arrivals. Its Studio link includes the selected request and service. Studio preserves its timeline, grouping, origin filtering, metrics and listener views, and adds common request inspection with optional service evidence. Service, outcome and search filters are in the URL. Rules are a disclosure for applicable operations.

AI rates use the retained host requests in served mode, including a late subscriber's history. Embedded page-only operation retains its SDK observation path. Saved rate captures keep their existing maximum of 100 request detail records; aggregate measurements cover the selected interval and response bodies are omitted from those captures.

## Automated verification

After compiling Pyric, CLI and Studio with their package `tsconfig.json` files, rebuild the embedded Studio assets:

```sh
bun packages/studio/scripts/copy-assets.ts
DOCS_BASE=/__pyric/ui/ bun run --cwd packages/site-docs build
cp -R packages/site-docs/dist/. packages/cli/dist/serve/site-ui/
```

The focused real-browser checks use a local synthetic provider and clean up their servers, workers, browser pages, and temporary fixtures:

```sh
node packages/cli/node_modules/@playwright/test/cli.js test \
  --config packages/cli/test/e2e/hosted/playwright.config.ts \
  worker-ai-traffic.pw.ts vite-ai-upstream.pw.ts
```

The worker checkpoint transfers a fresh backend port to a separate worker. It checks pending visibility in both UIs, completed response inspection, 140 subsequent Firestore requests, stable paging while traffic arrives, late Studio, page reload, request deep links, unknown IDs, rates, database rules inspection, and a narrow viewport. The upstream tests also check Node/SharedWorker parity and absence of duplicate AI rows from the page adapter.

Unit coverage includes request replay, retention and browser byte accounting, interruption, cancellation, failures, issue-time identity, credential redaction, older rate history, synthetic token provenance, and the existing chip/listener/rules/capture workflows.

## Manual verification in Orbit

1. Restart Orbit with the updated CLI build and reload the app and Studio tabs. Keep `TEAMS_HOSTED=1` for Node mode; omit it for SharedWorker mode.
2. Generate a new AI response using synthetic text.
3. Open the chip, select Traffic, and filter Requests to AI Logic. Open the request and expand Response.
4. Use Inspect in Studio. Check the requested/routed/reported models and the same returned text. No Security Rules section should appear for AI.
5. Return to the chip's Rates view and open AI Logic. A stream counts once, including after reloading the page.
6. Generate database traffic, use Load older, and confirm the list stays pinned while new requests arrive. Resume live to include new arrivals.
7. In Studio, switch to Firestore, inspect a recorded request, and expand Security Rules. Back to the log should retain the filter.

The other agent's family example checkout and server are unchanged. It needs these changes integrated and its own server restarted before that example can use the new observation path.

## Results in this checkout

- 159 focused tests passed in 4.6 seconds across 18 files.
- The sandbox suite passed 1,741 tests in 9.6 seconds (2 existing optional tests skipped).
- Node and SharedWorker browser AI parity checks passed; each shows exactly two requests for one unary call and one stream.
- The independent-worker/Studio browser checkpoint passed in 5 seconds, including paging, cold reads, reload, rates, filters, rules inspection and mobile layouts.
- Pyric, CLI, Studio and hosted-browser TypeScript checks passed.
- Test-owned browsers, local upstreams and Vite fixtures were closed. Orbit was restarted on port 5217 in Node mode; its health endpoint reports the sandbox connected.
