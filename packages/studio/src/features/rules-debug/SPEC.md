# Rules-failure debugging (Pyric Studio F4) — prose spec

The page has three surfaces: a **list** of denied ops (newest first), a
**detail** for the selected denial (the denying rule node + why, plus the
request the rule saw), and two **re-run** actions (impersonate the attempting
user; test an edited ruleset). Every surface is a projection of the unified
event stream — no re-derivation from out-of-band state. A denial is a
`result:'deny'` (or `'unsupported'`) `RequestEvent` (Firestore's simulator
shape) or `SandboxOperationEvent` (the service-neutral shape RTDB/Storage
emit). The projection reads whatever the emitting service's rules engine
already put on the wire; it never invents a parallel denial shape.

## What each service's rules engine hands us (verified in source)

### Firestore

The in-process simulator (`SimulateFirestoreRulesHandler`,
`packages/pyric/src/rules/simulator/`) runs per op and stamps
`RequestEvent.reasons[]` (`Rule #N (ops) → deny`, plus get()/exists() context
lines) and `matchedRule { ruleIndex, operations }`. `explainDenial` reads that
trace: the matched `allow` rule, or an implicit deny when nothing matched.
`request.auth`, `path`, `method`, the proposed `request.resource.data`, and
the pre-write `resource` are all on the event.

Deeper still, `RuleEvaluation.expressionTrace: ExprTraceEntry[]`
(`evaluator.ts:139-258`) carries a full sub-expression trace with short-circuit
`skipped` placeholders, let-bindings, and function inlining, and
`RuleEvaluation.line` is the 1-indexed source line. These are NOW threaded to
the event stream (additive `RequestEvent.evaluatedRule`, see "Threading the
line + sub-expression trace" below) and drive the ✓/✗ line marker and the
"show the work" step-through. `DenialContext.failedFields` remains undefined
(unused by this page).

**Explains**: headline, matched rule `Rule #N (ops)` or implicit deny, full
`Rule #N (ops) → deny` trace lines, `request.auth`, path/method, proposed
`request.resource.data`, pre-write `resource`.

**Re-runs**: both live — impersonate via the worker's
`setLens({mode:'as',uid})` seam (`rerunAsUser`); edited ruleset via
`fork(snapshot, editedRules)` + `lintFirestoreRules` + re-issue + diff
(`rerunAgainstRules`).

#### The rules inspector opens ALLOWED ops too

The Traffic surface's mount of this detail is the **RULES INSPECTOR**
(`features/traffic/TrafficRulesInspector.tsx`, `?inspect=<id>` — renamed from
"denial inspection" / `?denial` when it generalized; nothing external depended
on the old URL). Clicking ANY rules-evaluated row — allow or deny
(`opensRulesInspector` in `traffic/verdict.ts`) — opens it in place;
admin-bypass and blank-verdict rows keep their subject navigation, since rules
never ran for them and there is no decision to inspect.

For an ALLOWED op the inspector renders the same anatomy, honestly re-grounded:
an ALLOWED badge (the existing allow color language — violet accent, never
green outside diff-add), the headline naming the rule that GRANTED access
(`Rule #N (ops) allowed …`, from the same `matchedRule` parse — the simulator's
`parseMatchedRule` picks the `→ ALLOW` line for allows), the same
reasons/trace lines, the same inspectable request/resource/auth variables, and
the rules source view with the MATCHED line emphasized — a ✓ gutter marker on
an add-tinted line (`--diff-add`/`--diff-add-bg`) instead of ✗/remove-tint.
The show-the-work step-through renders for allows too (the simulator's
`expressionTrace` rides the same `TestResult`), with ✓ on the passing branch.

Re-runs on an allow: the edited-ruleset re-run stays — it answers "would my
edit BREAK this allowed op?" (the divergence diff reports flips both ways).
The impersonation row keeps the same gating as denials: shown only when the op
ran as an authenticated user.

The projection: `selectRuleEvaluations(events)` (model.ts) includes allow AND
deny/unsupported; `selectDenials` remains the deny-only filter for
denial-centric surfaces. `Denial.result` says which verdict an op carries (the
type name is historical; the doc comment owns that honestly).

#### The rules editor + deciding-line emphasis

Both rules views use a real CodeMirror 6 editor (`RulesCodeEditor.tsx`), reusing
the SAME CodeMirror package set the playground's `CmEditor` uses
(`codemirror` + `@codemirror/{state,view,language,commands,autocomplete,lint,
search}` + `@lezer/highlight`, matched versions). There is no first-party
Firestore-rules language, so — like the playground — it highlights via the
JavaScript extension (`service`/`match`/`allow`/`if` read as keywords), with a
muted custom `HighlightStyle`. The editor is code-split behind
`React.lazy` (`LazyRulesCodeEditor.tsx`): CodeMirror stays out of the Studio
main bundle and loads only when a denial is actually inspected.

Two views, both marking the deciding line:

- the READ-ONLY "what happened" view shows the DEPLOYED ruleset
  (`useStudioRulesSource()`), read-only, and
- the EDITABLE "re-run against an edited ruleset" buffer replaces the old plain
  `<textarea>`.

DECIDING-LINE EMPHASIS: the simulator's `RuleEvaluation.line` (1-indexed source
line of the deciding `allow` rule) is threaded to the event stream (below) and
rendered as a gutter marker plus a tinted line background on that line, in BOTH
views — ✗ on `--diff-remove-bg` for a deny, ✓ on `--diff-add-bg` for an allow
(`markLine`/`markKind` on `RulesCodeEditor`) — so the eye lands on the rule
that decided. Implemented with the real CodeMirror `Decoration.line` +
`gutter`/`GutterMarker` APIs (the playground only used the lint gutter, which
can't tint a whole line). Absent when the simulator didn't thread a line
(implicit deny, simulator-error deny, or RTDB/Storage).

#### Threading the line + sub-expression trace (additive pyric change)

Previously `renderLegacyDebugMessages` flattened the simulator's structured
`RuleEvaluation[]` to strings at the event boundary, dropping `line` and
`expressionTrace`. Two additive, internal-only changes carry them through (no
mirrored Firebase API touched):

- `packages/pyric/src/rules/test/spec.ts` gains `projectEvaluatedRule(result)`
  → `EvaluatedRuleInfo { verdict, line?, expression?, expressionTrace? }`. For
  an ALLOW it picks the `→ ALLOW` trace entry (evaluation short-circuits on the
  first allowing rule); for a DENY the first `DENY`/`ERROR` entry (fallback:
  last evaluated). It returns `undefined` for an implicit deny or an
  `UNSUPPORTED` abstention — never invents data. (This began as the deny-only
  `projectDenyingRule`/`RequestEvent.deniedRule`; it generalized — and all
  readers migrated — when the rules inspector started opening allowed ops.
  Nothing was published on the old names.)
- `RequestEvent` (`sandbox/types.ts`) gains an optional `evaluatedRule:
  EvaluatedRuleInfo`, populated in `buildRequestEvent` (from the emit sites
  that already hold the `TestResult`) on `result: 'allow' | 'deny'`, never on
  `unsupported`.

Studio's `toDenial` copies `evaluatedRule` onto `Denial.evaluatedRule` (and
stamps `Denial.result`). Everything downstream is a pure projection over that.

#### Show the work — the sub-expression step-through

"The denial is the answer to a math problem — show how we got there." For a
Firestore denial that carries an `expressionTrace`, `projectTraceSteps(denial)`
(pure, in `model.ts`) rebuilds the AST tree from the flat `ExprTraceEntry[]`
(via each entry's `parent` index) into `TraceStep`s, each classified by
`outcome`: `true` / `false` (the ✗ branch) / `skipped` (a `&&`/`||` operand
short-circuited, not evaluated) / `error` / `value` (a non-boolean operand).
The UI (`TraceWork`) renders each sub-expression indented under its operator,
with its evaluated value, the false branch marked ✗, skipped operands greyed
and struck through, and `let`-bindings / inlined-function frames labelled. This
is Firestore-only (the only engine that emits a sub-expression trace); for
RTDB/Storage the section is absent (their engines give a node/reasons, not a
sub-expression tree — rendered as before, no faked depth).

#### What the rule saw — inspectable variables

`ruleVariables(denial)` (pure) projects the rules-language variables the denial
evaluated against — `request.auth`, `request.method`, `request.path`,
`request.resource.data`, `resource` — from the context already on the event
(`auth`, `resourceData`, `resourceBefore`). The UI (`VariablesInspector`)
renders each as a read-only expandable key:value tree (the doctree idiom). A
value genuinely not captured for a denial (e.g. `request.resource.data` on a
read, `resource` on a list) is shown as honestly ABSENT with a one-line reason,
never as an empty object.

### RTDB

`SimulateHandler.execute` (`packages/pyric/src/database/simulation/handler.ts`)
walks the rule tree via `collectAncestors()` with first-true-wins cascade for
`.read`/`.write`, and for a write ALSO walks `.validate` at and below the
write location (`findFailingValidate()` — it knows WHICH rule node failed).
Its verdict — `{ allowed, matchedPath, matchedRule, reason,
pathVariableBindings }` — rides on `SandboxOperationEvent.rules`
(`engine:'rtdb'`). The `reason` string is the mechanical tell of WHICH rule
node denied: `'Validation rule evaluated to false'` ⇒ a non-cascading
`.validate` at `matchedPath` rejected the proposed value; otherwise a
`.write`/`.read` gate at `matchedPath` evaluated false; a `NO_MATCHING_RULE`
errorCode ⇒ RTDB implicit deny. `pathVariableBindings` ($roomId → r1) and the
raw `matchedRule` expression are surfaced verbatim.

**Explains**: headline naming the exact `.write` vs `.validate` node and its
path, the raw rule expression (`matchedRule`), `$variable` bindings, the data
evaluated (proposed write / existing value), `request.auth`.

**Re-runs**: both **pending** — the pure `SimulateHandler` is the mechanical
substrate, but the Studio worker does not yet expose a denial re-run operation.
There is also no whole-ruleset RTDB linter yet, so the edited-ruleset re-run
must name that gap. Re-running is honestly a simulation, never framed as a
production operation.

### Storage

`enforceRules` (`packages/pyric/src/storage/enforce.ts`) calls
`evaluateStorageRules` (`packages/pyric/src/storage/rules.ts`), whose
`EvaluationResult.reasons: string[]` name the match block that denied —
free-text lines like `match /sessions/{id} write: condition false`, or
`no rule matches write /path` for an implicit deny. There is no rule
index/line/sub-expression trace, by design (Storage's engine doesn't build
one). Denials surface as a `StorageError` with code `storage/unauthorized`
(NOT a `SandboxError`, so no `DenialContext`).

**Explains**: headline naming the `match` block + verb whose condition was
false (or implicit deny), the free-text reasons verbatim, request context
(path, method, `request.auth`; size/contentType when present on the event).

**Re-runs**: both **absent** — no `storage_simulate_rules` tool exists
(`evaluateStorageRules` is internal, not exposed as a mechanical tool), so
there is nothing to re-issue an op against even in principle. Compounding
this, the served worker never wires storage rules at all: `serve-init.ts`
sets Firestore + RTDB rules but not Storage, and `host.ts:610-659`'s own
comment says worker-mode Storage is effectively open — so a live Storage
denial cannot occur in served mode today, and Storage does not yet emit a
`SandboxOperationEvent { service:'storage', result:'deny',
rules.engine:'storage' }` onto the stream at all (it only throws
`storage/unauthorized`; the allow path emits `service_mutation`). Both gaps
are named in the disabled-hint copy: the missing `storage_simulate_rules`
tool, and the missing denial-event emitter.

## Re-run, mapped to real mechanical tools

Two re-run actions, each graded `live` / `pending` / `absent` per service
(`rerunSupport(denial)` in `model.ts`):

| Action | Firestore | RTDB | Storage |
|---|---|---|---|
| Impersonate attempting user | **live** — worker `setLens({mode:'as',uid})` seam, real backend | **pending** — needs a `SimulateHandler` re-run operation wired into the Studio worker | **absent** — no `storage_simulate_rules` tool exists |
| Test an edited ruleset | **live** — `fork` + `lintFirestoreRules` (surfaced pre-run) + `firestore_simulate_rules` (via `issueOp`) + structural `diff`, same now-denied/now-allowed classification `pyric verify`'s `deriveRulesTestCases` performs, applied to one op | **pending** — needs `RulesEvaluator.setRules` + a `SimulateHandler` re-run operation, and there is no whole-ruleset RTDB linter yet | **absent** — needs `storage_simulate_rules` AND the storage denial-event emitter above |

For the edited-ruleset re-run, a **parse failure is the only hard blocker**:
an unparseable ruleset can't be forked/simulated, so the re-run
short-circuits and reports the parse error. Security-level lint findings
(e.g. `RECURSIVE_WILDCARD_OPEN`) are surfaced but do NOT block — the whole
point of the "what if" re-run is to try loose candidate rules and watch the
decision flip.

**Re-run op shape (list/query).** A `list`/`listen` denial's `path` is the
COLLECTION (an odd number of segments), so re-issuing it as a document read —
`getDoc(doc(db, path))` — throws a raw SDK `INVALID-ARGUMENT` ("document path
must have an even number of segments"), which is an op-shape error, NOT a rules
verdict. `issueOp` re-issues list/listen denials as a collection read
(`getDocs(query(collection(db, path)))`) so the re-run reflects the actual list
rule decision. Raw SDK errors that do slip through are classified
`outcome: 'error'` and rendered with a neutral error badge — never as a `deny`
verdict.

**Impersonation, only when there is a user (item 6).** The "re-run as the
attempting user" row is shown ONLY for a denial with a concrete `request.auth.uid`
(`shouldOfferImpersonation(denial)`). For an unauthenticated denial
(`request.auth == null`) the row is dropped entirely rather than shown as a
disabled "no user to impersonate" button: the accurate frame is that the request
was unauthenticated, and re-running as the SAME (absent) identity isn't
impersonation. Real impersonation — running as a DIFFERENT user — is a future
"run as a different user" picker (roadmap, not now); when it lands it becomes the
meaningful control for the unauthenticated case too.

Controls a service can't yet back stay **disabled with a hint that names the
exact missing mechanical tool** — the same convention Firestore already uses
when the live worker isn't wired. Nothing is faked; the denial → rule →
context view is fully live for any denial the stream carries, for all three
services, today.

## Pane conventions

`RulesDebug.tsx` stays pure-props (no worker, no fetch); `RulesDebugPane.tsx`
is the only backend-aware layer, mirroring every other Studio pane. Styling
is token-only (`packages/studio/src/styles/tokens.css` /
`packages/studio/src/styles/index.css`): the severity ramp
(`--color-severity-*`), `--color-danger` / `--color-primary` (violet accent,
no green — green is reserved for the diff-add token, not general emphasis),
intrinsic CSS with gap-only spacing, stacked labels above values. Every
control's label says exactly what it does ("Impersonate bob", "Test on a
branch") rather than a generic "Run".
