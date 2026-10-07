# RTDB Security Rules

RTDB rules are JSON-embedded expressions where access cascades downward: a
permissive parent grants every descendant, and a restrictive child cannot
revoke it. Lock the root, then open the smallest useful paths.

## Rule types

- `.read` / `.write`: WHO may act at this path (and everything below it).
- `.validate`: WHAT the written data may look like, evaluated only after
  `.write` allows; validations do not cascade.
- `.indexOn`: which child keys or `.value` a query may order by at this path.
- `data`: pre-write state (the actor's existing context);
  `newData`: post-write state. In multi-field writes each `.validate` sees
  the full merged `newData`.

## Evaluation semantics to rely on

- `==` and `!=` compare without type conversion, as production does: `5 == '5'`
  and `1 == true` are false, and `==` behaves like `===`. A `.validate` such as
  `newData.val() == '5'` accepts the string and rejects the number.
- A rule that raises a runtime error does not grant. Calling `toUpperCase()` on
  a number raises one, and so does a `null` operand of an ordering or arithmetic
  operator, such as `data.child('n').val() > 1` when `n` does not exist. A
  `.validate` that errors rejects the write; a `.read` or `.write` that errors
  falls through to the next rule on the path. The result is a deny, never an
  abstention.
- A write is allowed only when a `.write` rule grants it and every `.validate`
  at and below the written path passes.
- `.indexOn` is checked on queries ordered by child or by value. `get()` of an
  unindexed query rejects with `Index not defined, add ".indexOn": ...`. A
  listener on it still delivers the filtered data and logs
  `Using an unspecified index` when the query has a limit or a range. `orderByKey`
  needs no index.

## Steps

1. **Read current rules.** From `database.rules.json` in the project, or the
   deployed ruleset read back through the Firebase Console or `firebase-tools`.
   Complete when you can state the effective access at every path a client
   touches (walk each cascade from root).

2. **Identify paths and identities.** List each path clients read or write
   and the identity that should reach it (anonymous, any signed-in user,
   owner via `auth.uid`, role via claim). Complete when each path has an
   intended identity × operation table.

3. **Design access and validation together.** Start from
   `{ "rules": { ".read": false, ".write": false } }` and open exact paths.
   Guard identity with `auth !== null` before `auth.uid` comparisons. Add a
   `.validate` for every user-controlled write: type checks
   (`newData.isString()`, `.isNumber()`), bounds, required children
   (`newData.hasChildren([...])`), and transition checks comparing `data` to
   `newData`. Add `.indexOn` for every child or value a query orders by.
   Complete when every open path has both an access rule and a shape rule.
   To author the rules in TypeScript instead of JSON, see
   `docs/secure/rtdb-rules-in-typescript` and generate the JSON with
   `pyric database rules generate`.

4. **Lint, then simulate before shipping.** Run `rules.lint()` (or
   `pyric rules lint --service database --rules-file database.rules.json`) and
   fix every error. The type and shape errors, such as `NOT_BOOLEAN`,
   `INVALID_OPERAND`, `NO_SUCH_MEMBER` and `MULTIPLE_WILDCARDS`, are the ones
   `firebase deploy` refuses, with the deploy's own message; `pyric sandbox`
   will not load a rules file that has one. Lint also reads the whole ruleset
   and reports `RTDB-SEC-1` to `RTDB-SEC-7`, each with the rule it sits on and a
   `fix`: a public `.write` or `.read`, a conditional `.write` that never reads
   `auth`, a deeper rule that cannot revoke an ancestor's grant, a `.validate`
   that a delete skips, a `.write` with no shape check, and a node with no
   `$other` rule. Then test with explicit cases, as the next section shows.
   Complete when lint reports no errors and four case families pass per path:
   the intended actor allowed, anonymous denied, cross-user denied, invalid
   shape denied.

5. **Deploy.** Write the full `database.rules.json`, since a deploy replaces
   the entire ruleset, and ship it with `firebase deploy --only database` or the
   Console. Complete when the deployed rules, read back through the Console or
   `firebase-tools`, match the file, and the step 4 cases still pass against a
   local copy of the same file.

## Test the rules directly

For a question about the rules themselves, such as "can the owner write, can a
reviewer only read, is everyone else denied", evaluate the actual rules with
explicit cases. Do not start by creating Auth users, signing in SDK clients,
seeding a database, or redirecting SDK imports to a mock. None of that is needed
to test a predicate.

### Discover the installed API first

The direct API is `rtdbRules` from the `pyric/rules` entry point. There is no
`pyric/rules/rtdb` subpath; do not import one. Confirm the export in the
installed version before writing code:

```bash
bun -e "const m = await import('pyric/rules'); console.log(typeof m.rtdbRules, typeof m.assertCase)"
```

Expected output is `function function`. If `rtdbRules` is `undefined`, the
installed `pyric` predates it. Say so, use the `rtdb_simulate_access` tool
against the sandbox instead, and name the version requirement in the report.

### Run an allowed case and its denied neighbors

```ts
import { test } from 'bun:test';
import { rtdbRules, assertCase, type RtdbCase } from 'pyric/rules';

const rules = rtdbRules({
  rules: {
    '.read': false,
    '.write': false,
    records: {
      $recordId: {
        '.read':
          "auth != null && (data.child('ownerId').val() === auth.uid || data.child('reviewers').child(auth.uid).exists())",
        '.write':
          "auth != null && (data.exists() ? data.child('ownerId').val() === auth.uid : newData.child('ownerId').val() === auth.uid)",
        '.validate': "newData.hasChildren(['ownerId', 'title'])",
        title: { '.validate': 'newData.isString() && newData.val().length <= 80' },
      },
    },
  },
});

const stored = {
  records: { r1: { ownerId: 'alice', title: 'Quarterly plan', reviewers: { rita: true } } },
};
const revised = { ownerId: 'alice', title: 'Revised plan', reviewers: { rita: true } };

const cases: RtdbCase[] = [
  { description: 'owner writes', expectation: 'ALLOW', operation: 'write', path: '/records/r1', auth: 'alice', data: stored, newData: revised },
  { description: 'reviewer reads', expectation: 'ALLOW', operation: 'read', path: '/records/r1', auth: 'rita', data: stored },
  { description: 'reviewer cannot write', expectation: 'DENY', operation: 'write', path: '/records/r1', auth: 'rita', data: stored, newData: revised },
  { description: 'unrelated user cannot read', expectation: 'DENY', operation: 'read', path: '/records/r1', auth: 'mallory', data: stored },
  { description: 'signed-out user cannot read', expectation: 'DENY', operation: 'read', path: '/records/r1', auth: null, data: stored },
  { description: 'title over 80 characters', expectation: 'DENY', operation: 'write', path: '/records/r1', auth: 'alice', data: stored, newData: { ...revised, title: 'x'.repeat(81) } },
];

for (const c of cases) test(c.description!, () => assertCase(rules, c));
```

`rules.simulate(cases)` returns `{ passed, failed, unsupported, cases, coverage }`
without throwing; for the six cases above it reports 6 passed, 0 failed,
0 unsupported. Each result has `decision`, `matchedPath`, `matchedRule`,
`reason`, and a `trace` of every rule the evaluation ran (root first, with a
verdict of `ALLOW`, `DENY`, `ERROR`, or `UNSUPPORTED`).
`assertCase` throws with the deciding rule in the message when a case misses.

`coverage` reports each `.read`, `.write`, `.validate` and `.indexOn` node with
a `status` of `allow`, `deny`, `error`, `mixed`, `unsupported`, or
`never-evaluated`. `coverage.uncovered` lists the nodes no case reached, and
`coverage.missingIndexes` lists the queries no `.indexOn` serves. A node whose
status is `allow` has no case it denies: add the denied neighbor before calling
the rule tested. `renderRtdbCoverage(rules.coverage(summary.cases, { file, source }))`
prints the report with the line of each rule key in `source`.

Case fields:

- `operation` is `read`, `write`, `update`, or `validate` (`validate` runs only
  `.validate` rules).
- `path` is absolute from the database root.
- `auth` is a uid string, `{ uid, token }` for custom claims, or `null` for signed out.
- `data` is the tree before the request, from the root, not from `path`.
- `newData` is the value written at `path`, any JSON value. For `update`, it is
  the patch, keyed by paths relative to `path`, such as
  `{ 'r1/title': 'A', 'r2/title': 'B' }`.
- `query` is the query a `read` carries, such as
  `{ orderByChild: 'ownerId', equalTo: 'alice' }`, so `query.*` rules evaluate.
- `now` is epoch milliseconds. Pin it for any rule that reads `now`, so the verdict
  does not depend on the clock.

Keep the same rules and `data` across an allowed case and its denied
neighbors, and change one thing in each: the identity, the operation, or the
written value.

### What a case does and does not prove

- A `write` case evaluates the `.write` cascade, then every `.validate` at and
  below the written path. A `validate` failure is a deny and names the failing
  rule in `matchedPath`.
- An `update` case writes every path in the patch together. Each path is judged
  by the `.write` rules on its own path and by the `.validate` rules against the
  tree the whole update produces, so one refused path denies the update. Test a
  multi-path update as an `update` case, not as one `write` case per path.
- `UNSUPPORTED` means the simulator abstained on an expression it cannot
  evaluate. It is not a pass. Report it and run `rules.lint()` for the cause.
- `simulate` does not run the deploy check. A rule `firebase deploy` refuses can
  still evaluate in a case: a `.read` of `auth.uid` grants any signed-in reader.
  A passing case on a ruleset with lint errors proves nothing about production.

### Choose the test layer

| Question | Layer | Needs | Evidence it gives |
|---|---|---|---|
| Does this rule allow or deny this request? | Rules-only simulation (`rtdbRules(...).simulate`, `assertCase`, `rtdb_simulate_access`) | Rules JSON and case data | Behavior for the modeled cases, and coverage of the rules |
| Does the app's SDK code, identity, listeners and transactions hit the rules correctly? | Local SDK integration (sandbox with `withAuth` contexts) | `initializeSandbox`, `pyric/database`, signed-in contexts | The local implementation handling real calls |
| Would a captured session change verdicts under new rules? | `pyric verify --service rtdb --rules rtdb=database.rules.json` | A captured session | Divergences between old and new rules on the sandbox engine only |
| Does Firebase itself agree for this ruleset? | Live verification | A non-production Firebase project running the rules | The only evidence of production behavior |

Full SDK integration setup is optional extra coverage, not a prerequisite for
testing predicates. Local simulation does not establish production parity for
your ruleset. Live verification means deploying to a non-production project and
exercising the same cases with the Firebase SDK. The hosted Rules Test API
covers Firestore only, so `pyric verify --engine rules-test-api` is refused for
`rtdb`.

### Sandbox layer

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set, get, sandbox as databaseSandbox } from 'pyric/database';

const sandbox = initializeSandbox();
databaseSandbox.setRules(getDatabase(sandbox), rules.toJSON());

const alice = getDatabase(sandbox.withAuth({ uid: 'alice' }));
const mallory = getDatabase(sandbox.withAuth({ uid: 'mallory' }));

await set(ref(alice, 'records/r1'), { ownerId: 'alice', title: 'Plan' });
await get(ref(mallory, 'records/r1')); // rejects: PERMISSION_DENIED: Permission denied
```

`databaseSandbox.setRules` installs the ruleset as given, without the deploy
check, so lint first. Denials appear in `sandbox.onEvent` as
`kind: 'operation'`, `service: 'rtdb'`, `result: 'deny'`, with
`rules.matchedPath`, `rules.matchedRule`, `rules.reason`, and `rules.rtdbTrace`,
the same list of evaluated rules. The rejected error has production's class,
`code` and message, plus a `denialContext` property with the same fields.

### Explain one denial

The `rules` tool's `explainDenial` method with `service: 'database'` (CLI:
`pyric rules explainDenial --service database`) takes `operation`, `path`,
`uid`, `data` (the written value, or the patch for `update`) and, for a read,
`query`. It evaluates the running sandbox rules, or a draft passed as `rules`
(file text). `source`, the text the running rules were loaded from, adds file
lines only; pass one of `rules` and `source`, not both. The result says
`evaluated: 'running'` or `'draft'`, and `case` names `matchedPath`,
`matchedRule`, `ruleKind`, `why` (`evaluated-false`, `runtime-error`,
`no-rule-grants`, `unsupported`), `reason`, `trace`, `line` when file text is
known, and `fix` when one can be stated.

## Hot reload while iterating

`pyric sandbox` and the Vite plugin watch `database.rules.json` (or the path
`firebase.json` names under `database`), whether or not the file exists yet.
Creating or saving it loads it. A file that is not valid rules JSON, or that
`firebase deploy` would refuse, leaves the last good rules live and logs
`rtdb rules NOT reloaded` with the reason; at startup, such a file stops
`pyric sandbox`. Deleting it returns RTDB to the default policy (deny, or open
with `--permissive`) and logs `rtdb rules removed`. `--no-watch` turns this off.

## Reference: pitfalls

- A `.read: true` near the root silently exposes every descendant; recheck
  cascades after any parent edit.
- `.validate` never runs when `.write` denies, and never rescues a `.write`
  that is too broad.
- `data` at a path being created is empty; existence checks belong on
  `data.exists()`.
- Deleting a node is a write of `null`: `newData.exists()` in `.validate`
  blocks deletion. Decide intentionally.
- A query ordered by child or value without `.indexOn` passes in a listener with
  a console warning and fails in `get()`. Treat the warning as a defect.
