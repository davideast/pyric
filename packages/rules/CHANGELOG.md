# Changelog

## 0.1.0

First standalone release of `@pyric/rules`: in-process parsing, linting, simulation, and test assertions for Firestore, Cloud Storage, and Realtime Database Security Rules, with no emulator and no network calls (#1521). Requires Node 22 or later and bundles for browsers from its root entry, depending only on `ohm-js` and `zod` (#2594, #2600). `pyric/rules` remains a permanent re-export of `@pyric/rules` (#2594).

### Breaking changes

- Standalone package boundary (#2594, #2598): `@pyric/rules` exports the offline rules constructors (`firestoreRules`, `storageRules`, `rtdbRules`), `lint`, `assertCase`, `explainCase`, the Realtime Database constraints DSL and `rtdbStdlib`, value helpers, and coverage/diff utilities. `@pyric/rules/internal`, `/internal/node`, `/internal/rtdb`, and `/internal/storage` are unstable internal subpaths for Pyric's own packages and may change without notice. Production Rules API clients, MCP/agent tool factories, and TypeScript-backed index extraction stay in `pyric`.

### Behavior changes

- Added `storageRules(source, { bucket })` with `StorageCase`, `lint()`, `simulate(cases)`, `explain(case)`, and `assertCase` support, refusing cases whose paths or verbs (`get`, `list`, `create`, `update`, `delete`, `read`) production would interpret differently (#2599). Storage rules bind `request.auth.token` to `{}` when auth is given as `{ uid }` without a `token` map, bind `md5Hash`, `crc32c`, `etag`, `cacheControl`, `contentDisposition`, `contentEncoding`, and `contentLanguage` when present on `resource`, and bind `cacheControl`, `contentDisposition`, `contentEncoding`, and `contentLanguage` when present on `requestResource`.
- Non-Storage `service` headers in Storage rulesets compile to deny-all rather than failing to load (#2839).
- Firestore rulesets leave `{database}` unbound under literal `/databases/(default)/documents` roots and report the runtime type of a document reference as `path` (#3238).
- Wire-level refusals, root open-access lint (`SEC-1`), auth-guarded `SEC-5` / `SEC-6` owner-scope lint warnings, Storage path integer bindings, and Realtime Database `.validate` rule names match production (#3237, #3238).
- RE2 character-class escapes, case folding, `split()` regex checks, `NaN` equality, and grammar acceptance match production (#2646, #2647, #3232, #3234).
- Cases the engine cannot evaluate return `UNSUPPORTED` in `simulate` and `explain`, and `assertCase` throws `RulesUnsupportedError` rather than counting them as passed (#3231).

### Fixed

- Source-size lint and load checks enforce production's 262,144-byte ceiling and check service identity and duplicate `service` blocks before compile limits (#2594, #2646).
- Helper `let` bindings preserve lexical shadowing and trace projections, and Firestore lookup evaluation fails closed when the lookup frontier overflows (#2647).
- Standalone rules handles freeze returned data and preserve authored line numbers and ISO instant precision (#2607, #2646).

### Known gaps

- `StorageCase.requestResource` (`StorageRequestResource`) does not yet accept `md5Hash` or `crc32c` on writes or type `etag` as a string on metadata updates, and Pyric's Storage sandbox does not yet populate `request.resource.md5Hash`, `request.resource.crc32c`, or `request.resource.etag` (#3258).
