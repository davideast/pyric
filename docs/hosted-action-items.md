# Hosted mode: action items

The short list of what is actually open. The ledger (`docs/hosted-review-ledger.md`) holds the detail for each id; the release plan holds the history. Updated 2026-09-23.

## Needs the owner

1. **Approve publishing the Studio hosted client (ledger C15).** `slice/studio-hosted` at `e094d121`, nine files, proven. On `main`, Studio against a `--hosted` server reconnects in a loop with an empty live feed; the slice fixes it and leaves SharedWorker mode unchanged.

## In progress

2. **Runtime chip highlights do not work in real apps under the Node host (ledger C16).** Reported by the owner on 2026-09-23 after testing three Vite and React apps: hosted mode itself worked, but the chip's Overview and Flow highlights showed nothing in any of them.
   - Known: the repository's own spec for this feature, `test/e2e/hosted/vite-highlights.pw.ts`, passes in all four configurations on current code (Node and SharedWorker, with and without React DevTools). So the feature works in the repository fixture and fails in real installs.
   - What differs in a real install: Pyric comes from packed tarballs under `node_modules` rather than the workspace; the apps use JSX with `@vitejs/plugin-react` and Fast Refresh rather than `React.createElement`; React may be a different major version and may run under `StrictMode`.
   - Not reproduced, 2026-09-23. The reviewer built a real application from `pack-local.sh` tarballs (Vite 7, React 19, Firebase 12, JSX with `@vitejs/plugin-react`, `StrictMode`) and drove the chip as the spec does. Overview and Flow both painted, in Node host mode and in SharedWorker mode. The bundling hypothesis is refuted.
   - Needed from the owner, from one affected application: the output of `npm ls pyric @pyric/cli` (two copies of `pyric` would give the SDK and the chip separate activity journals, and the chip would fold nothing); whether highlights return in SharedWorker mode on the same install; what the chip's Data tab shows for the listener count; the browser console's errors; and where the application attaches its listeners (inside a component, or in a store or at module scope).

3. **`@pyric/cli` refuses to install beside Vite 8 (ledger I19).** Its Vite peer range stops at 7 and a freshly scaffolded React project gets Vite 8. Unrelated to hosted mode; found while reproducing item 2.

## Watching

4. **Popup sign-in acceptance hung once on `main` (ledger F6).** Unexplained, no recurrence. The browser conformance job now keeps traces on failure.
5. **`pyric snapshot` from a live persisted SharedWorker sandbox** is the one path in the migration skill written from source and not run end to end. Report what happens if it is used.

## Deferred until a trigger

A decision to announce hosted mode, a user other than the owner, or frequent work on the serve path reopens these: the hosted smoke set in CI, the full hosted Playwright suite, load baselines and the resident-memory ceiling (I6, I17), the shard fix (F5), the owed conformance captures (E1), and the rest of phase 5 (the traffic inspector redesign, the example app, packaging and workflow changes).
