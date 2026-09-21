# Hosted mode: action items

The short list of what is actually open. The ledger (`docs/hosted-review-ledger.md`) holds the detail for each id; the release plan holds the history. Updated 2026-09-23.

## Needs the owner

None. Pull request 665, the Studio hosted client (ledger C15), merged as `main` `4b5fe6ae` on 2026-09-23.

## In progress

2. **An application that imports `linkWithPopup` does not load in served mode (ledger I20; explains C16).** Found by running `davideast/book-app`. The served auth entry exports 34 of the engine's 75 auth names. A named import it lacks is a link-time `SyntaxError`: the module graph is rejected, React never mounts, `#root` stays empty, and the chip sits over a blank page with nothing to highlight. Same in SharedWorker mode and Node host mode; it predates the hosted work. Missing names include `linkWithPopup`, `linkWithCredential`, `unlink`, the three `reauthenticateWith*` functions, `sendPasswordResetEmail`, `sendEmailVerification`, `signInWithCustomToken`, `getIdToken`, and `getAdditionalUserInfo`.
   - Ruled by the owner on 2026-09-24 and assigned in channel message 0098, after C17 and ahead of I19.
   - Fix, first part: no import may blank an application. Every runtime name `firebase/auth` exports exists on the served entry; what cannot run yet throws a named `FirebaseError` when called. A test derives the names from the real `firebase/auth` package. Same check for the other served entries.
   - Fix, second part: forward the linking, reauthentication, and action-code functions the engine already implements, `linkWithPopup` first.
   - How it got imported: the agent that wrote the app asked `pyric_can_i_use`, which answered `available`. That is true of `pyric/auth`, the in-page engine, and the tool has no way to answer for the served `firebase/auth` entry: asked with that import path it matches nothing. Third part of the fix: the tool reports served availability.

3. **Overview on an idle page (ledger C17): fixed on the shared branch at `a6037b8c`, slice for `main` being cut by the reviewer.** Observation starts when the SDK initializes and keeps a bounded buffer of early renders, so turning Overview on paints what already rendered, before and after a reload, in both modes. Known limitation: a delivery that causes no React render, because the data equals the component's state, has no element to draw around.

4. **`@pyric/cli` refuses to install beside Vite 8 (ledger I19).** Its Vite peer range stops at 7 and a freshly scaffolded React project gets Vite 8. Unrelated to hosted mode. Ruled by the owner on 2026-09-24: prove the third-party dependency redirect under Vite 7 and Vite 8 first, feature-detect `rolldownOptions`, then widen the range. Assigned in channel message 0096, after C17.

## Watching

5. **Popup sign-in acceptance hung once on `main` (ledger F6).** Unexplained, no recurrence. The browser conformance job now keeps traces on failure.
6. **`pyric snapshot` from a live persisted SharedWorker sandbox** is the one path in the migration skill written from source and not run end to end. Report what happens if it is used.

## Deferred until a trigger

A decision to announce hosted mode, a user other than the owner, or frequent work on the serve path reopens these: the hosted smoke set in CI, the full hosted Playwright suite, load baselines and the resident-memory ceiling (I6, I17), the shard fix (F5), the owed conformance captures (E1), and the rest of phase 5 (the traffic inspector redesign, the example app, packaging and workflow changes).
