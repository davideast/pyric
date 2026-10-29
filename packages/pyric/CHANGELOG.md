# Changelog

## 0.1.0-alpha.30.2

Hotfix for App Check in sandbox AI mode. Sandbox AI mode now refuses AI Logic
requests without an App Check token, as production does from November 2, 2026,
and the gemini engine works on the Vite plugin's default SharedWorker plane.

### Behavior changes

- Sandbox AI mode now refuses requests without an App Check token, the way
  production does. If an app never calls `initializeAppCheck`, or calls it
  after `getAI`, then `generateContent`, `generateContentStream`,
  `countTokens` and chat messages fail with production's 403 error ("Firebase
  AI Logic has been deactivated in this project..."). An app that never called
  `initializeAppCheck` now needs to call it before `getAI`. Pyric prints how
  to fix it in the browser console and in the dev server terminal. This
  applies on the SharedWorker plane, with `hosted: true`, in the in-page
  sandbox, and in a server under `@pyric/cli/register`. Sandbox tokens from
  `initializeAppCheck` are accepted, with or without the debug provider.
  `getAI(sandbox)`, `createConfiguredSandboxAI` and production AI mode are
  unchanged. There is no flag to turn the refusal off (#1535).
- The dev server's AI proxy routes refuse requests from pages on other
  origins and request bodies over their size limit, so another site can't
  spend your AI key (#1431, #1592).

### Known issue: proxied AI engines under `pyric sandbox -- <cmd>`

- On this release a page served by a dev server that `pyric sandbox -- <cmd>`
  wraps, such as `next dev`, is refused with a 403 when it uses a proxied AI
  engine. That covers the openai engine, and the gemini engine on the
  SharedWorker or in-page plane. The wrapped dev server serves the page on its
  own port, which this release's AI proxy guard does not accept. The fix comes
  in alpha.31.

### Fixed: the gemini engine on the SharedWorker and in-page planes

- With `ai: { engine: { kind: "gemini" } }` on the Vite plugin's default
  SharedWorker plane or the in-page plane, requests now go through the dev
  server, which adds the Gemini key from its own environment. Apps get
  Gemini's answer instead of `process is not defined`. The key never reaches
  the browser, and Gemini errors relayed to the page have the key removed
  (#1592).

### Fixed: dev server

- `/__pyric/denials` refuses a request body over 64 KiB with a 413 (#1431).
- Control and bidi characters in relayed denial text are replaced with spaces
  before it reaches the terminal (#1431).
- A denial's suggested fix prints in full in the terminal instead of being
  cut short (#1431).

### Docs

- The AI Logic guide, the tutorial and the `ai-chat` example call
  `initializeAppCheck` before `getAI` (#1392).

## 0.1.0-alpha.30.1

Hotfix for production AI mode. Production AI mode now verifies real App Check
tokens on the server.

### Fixed: App Check in production AI mode

- A server running under `@pyric/cli/register` in production AI mode verifies
  the page's real App Check token with firebase-admin's own `verifyToken`, so
  it returns the page's app id instead of throwing `app-check/invalid-credential`.
  In sandbox AI mode such a token is refused with a message that says why
  (#1558).
- `cert(serviceAccount)` keeps the service account's project id, so App Check
  `createToken` and `verifyToken` work without `projectId` or
  `GOOGLE_CLOUD_PROJECT` (#1532).
- When the shadow Firebase app cannot be created in production AI mode,
  `initializeAppCheck` throws an error that names the app and the cause
  (#1534).
- Production AI mode on plain `pyric sandbox` serves the real `firebase/app`,
  `firebase/ai` and `firebase/app-check` from the project's own firebase
  install, so the page loads instead of failing on `firebase/ai` (#1537).

### Fixed: packaging

- The release contract's allowed Firebase SDK import edges drop a stale row,
  and a unit test derives the list from `packages/cli/src` (#1560).

## Unreleased

### Breaking: `pyric/database` is the canonical sandbox-only mirror

- `pyric/database` exports only the Firebase-shaped modular Database surface
  and sandbox-specific extensions.
- The duplicate `pyric/database/modular` subpath is removed. Import the mirror
  from `pyric/database`.
- Direct mirror calls reject real Firebase apps. Package resolution owns the
  backend swap: inactive production code imports `firebase/database`, while
  Pyric activation maps that canonical import to the sandbox mirror.

### Added: local Realtime Database inspection

- `rtdbRules({ rules: ... }).simulate(cases)` now evaluates compiled RTDB
  rules JSON directly. It does not fetch rules or depend on a prior tool call.
- `pyric/sandbox/database` exposes owner controls for installing RTDB rules,
  seeding data, and reading detached snapshots from a `LocalSandbox`. These
  controls share the same backend used by the `pyric/database` mirror.

### Breaking: `pyric/rules` public API replaced

`pyric/rules` shipped an accidental public surface of roughly 135 exports
spread across six subpaths (`./rules`, `./rules/node`, `./rules/extract`,
`./rules/rtdb`, `./rules/rtdb/constraints`, `./rules/rtdb-constraints`). That
surface exposed parser internals, simulator handlers, resolver plumbing, zod
schemas, and tool factories that were never meant to be part of the contract.
It is replaced, in one clean break, with a small curated front door. This is
an alpha release two days after publish; there are no deprecated aliases.

**Removed subpaths.** `./rules/node`, `./rules/extract`, `./rules/rtdb`,
`./rules/rtdb/constraints`, and `./rules/rtdb-constraints` no longer exist.

**The new `pyric/rules` surface:**

- `firestoreRules(source)` — compiles Firestore rules into a deep,
  safe-by-default handle: `lint()`, `simulate(cases)`, `explain(case)`,
  `toJSON()`. The constructor throws `RulesCompileError` (with `.issues`) on
  unparseable source; past that, `simulate` never throws on a rule outcome.
- `rtdbRules(defOrDocOrJson)` — the same handle for Realtime Database rules,
  accepting a definition, an authored document, or compiled `{ rules }` JSON.
  The `RtdbRulesDocument` that `defineRtdbRules` returns is inert on the
  public surface: the type exposes no methods (no `check()`, `simulate()`,
  `toJSON()`, or `toIR()` on the document itself). It is an authored artifact
  you pass to `rtdbRules()`, which is the one analysis surface. The
  method-bearing document interface remains available to engine consumers on
  the internal seam.
- `lint(source)` — a tolerant free function that accepts any source
  (including broken or empty), never throws, and returns every issue.
- `assertCase` / `explainCase` — the assertion adapter that bridges to a
  throwing test runner, the one throwing verb beyond the constructors.
  `assertCase(result)` asserts an already-simulated `CaseResult`;
  `assertCase(ruleset, oneCase)` (and the `assertCase(source, oneCase)`
  convenience for Firestore) simulates that single case and throws
  `RulesAssertionError` on a failed case or `RulesUnsupportedError` on a
  simulator abstention, with the `explainCase` trace as the message. Runner
  wiring: `for (const c of cases) test(c.description, () => assertCase(ruleset, c))`.
  `explainCase` is the single sanctioned trace renderer.
- `RuleIssue` — one unified diagnostic (`code`, `severity`, `message`,
  `path?`, `line?`, `fix?`, `origin`) replacing the former `LintWarning` /
  `ValidationFinding` / `ParseError` split.
- Distinct `FirestoreCase` and `RtdbCase` shapes (not unified), plus the
  structured trace types (`RuleEvaluation`, `PathResolutionTrace`,
  `PathResolutionEntry`, `ExprTraceEntry`) as plain data.
- Value helpers: `serverTimestamp`, `timestamp`, `bytes`, `latlng`,
  `duration`, `reference`, `vector`.
- The Realtime Database constraints DSL (`defineRtdbRules` and its
  combinators) is re-exported unchanged as siblings.

Storage rules are not covered here yet.

**Migration.** Callers that authored/linted/simulated rules through the old
handlers move to the constructors:

```ts
// before
import { lintFirestoreRules, SimulateFirestoreRulesHandler } from 'pyric/rules';
const { warnings } = lintFirestoreRules(src);
const { data } = new SimulateFirestoreRulesHandler().simulate(src, cases);

// after
import { firestoreRules, lint } from 'pyric/rules';
const issues = lint(src);                       // tolerant, RuleIssue[]
const summary = firestoreRules(src).simulate(cases);
```

The RTDB constraints DSL now imports from `pyric/rules` (it used to live on
`pyric/rules/rtdb` and `pyric/rules/rtdb/constraints`):

```ts
// before
import { defineRtdbRules, allow, deny } from 'pyric/rules/rtdb';
// after
import { defineRtdbRules, allow, deny } from 'pyric/rules';
```

The low-level engine (parser, linter, simulator handlers, resolver,
wrappers, RTDB machinery, agent-tool factories, composite-index extractor)
remains available to deep and tooling consumers on internal seams —
`pyric/rules/internal`, `pyric/rules/internal/node`,
`pyric/rules/internal/rtdb`, and `pyric/rules/internal/extract` — mirroring
the existing `pyric/sandbox/internal` and `pyric/storage/internal` pattern.
These are not part of the public contract and may change without notice.
