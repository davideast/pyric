# Changelog

## Unreleased

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
  accepting a definition, a compiled document, or compiled `{ rules }` JSON.
- `lint(source)` — a tolerant free function that accepts any source
  (including broken or empty), never throws, and returns every issue.
- `eachCase` / `assertCase` / `explainCase` — the assertion adapters that
  bridge to a throwing test runner. `run()` throws `RulesAssertionError` on a
  failed case and `RulesUnsupportedError` on a simulator abstention;
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
