# Hosted mode: action items

The short list of what is actually open. The ledger (`docs/hosted-review-ledger.md`) holds the detail for each id; the release plan holds the history. Updated 2026-09-23.

## Needs the owner

1. **Approve publishing the Studio hosted client (ledger C15).** `slice/studio-hosted` at `e094d121`, nine files, proven. On `main`, Studio against a `--hosted` server reconnects in a loop with an empty live feed; the slice fixes it and leaves SharedWorker mode unchanged.

## In progress

2. **Runtime chip highlights do not work in real apps under the Node host (ledger C16).** Reported by the owner on 2026-09-23 after testing three Vite and React apps: hosted mode itself worked, but the chip's Overview and Flow highlights showed nothing in any of them.
   - Known: the repository's own spec for this feature, `test/e2e/hosted/vite-highlights.pw.ts`, passes in all four configurations on current code (Node and SharedWorker, with and without React DevTools). So the feature works in the repository fixture and fails in real installs.
   - What differs in a real install: Pyric comes from packed tarballs under `node_modules` rather than the workspace; the apps use JSX with `@vitejs/plugin-react` and Fast Refresh rather than `React.createElement`; React may be a different major version and may run under `StrictMode`.
   - Leading hypothesis, untested: listener owners are derived on the page from the call stack, skipping frames that live in the client's own directory. Under `node_modules`, Vite pre-bundles dependencies into `.vite/deps`, which would move those frames out of that directory, so the caller would be misidentified and no owner would be placed.
   - Next: reproduce in a throwaway Vite and React app installed from `pack-local.sh` tarballs, in both modes, then bisect between the fixture and the real app.
   - Open questions for the owner: does the same install show highlights in SharedWorker mode (drop `hosted: true` and reload)? Which React version do the three apps use? Did the chip's listener count read zero, or did it count listeners and paint nothing?

## Watching

3. **Popup sign-in acceptance hung once on `main` (ledger F6).** Unexplained, no recurrence. The browser conformance job now keeps traces on failure.
4. **`pyric snapshot` from a live persisted SharedWorker sandbox** is the one path in the migration skill written from source and not run end to end. Report what happens if it is used.

## Deferred until a trigger

A decision to announce hosted mode, a user other than the owner, or frequent work on the serve path reopens these: the hosted smoke set in CI, the full hosted Playwright suite, load baselines and the resident-memory ceiling (I6, I17), the shard fix (F5), the owed conformance captures (E1), and the rest of phase 5 (the traffic inspector redesign, the example app, packaging and workflow changes).
