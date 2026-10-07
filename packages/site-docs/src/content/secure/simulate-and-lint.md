---
title: "Simulate and lint Security Rules before deployment"
navLabel: "Simulate and lint before you deploy"
group: "Secure & debug"
section: ""
order: 20
description: "Get a rules verdict and a lint report locally, before production answers with an unexplained 400 or 403."
---

# Simulate and lint Security Rules before deployment

A broken ruleset fails late: a `400` at deploy time, or a `403` at runtime. Pyric moves both failures to your machine, before the deploy.

Simulation tells you what a rule decides. Linting tells you what the production compiler and runtime will reject, and why, in the language of the mistake you made.

## Simulate a hypothetical request

Ask the simulator whether a specific request would be allowed. It runs in-process, no network, no project:
```ts
import { firestoreRules } from 'pyric/rules';

const result = firestoreRules(source).simulate([
  {
    description: 'unauthenticated read is denied',
    expectation: 'DENY',
    method: 'get',
    path: 'notes/n1',
  },
]);
```
Each result is `PASSED`, `FAILED`, or `UNSUPPORTED`, and each carries `debugMessages`, a trace naming the rule that decided:
```
Rule #0 (read) → deny
Simulated: DENY
```
`UNSUPPORTED` means the simulator hit a feature it does not implement and abstained rather than guessed. Those cases can be routed to Google's own engine. See [write a rules test suite](./write-a-rules-test-suite.md).

The same simulator is on the command line as `pyric rules simulate --service firestore --operation <op> --path <path>`, and it is what evaluates every operation inside your running sandbox.

## Lint before Firebase rejects the rules
```bash
pyric rules lint --service firestore
```
Or in code:
```ts
import { lint } from 'pyric/rules';

const issues = lint(source);
```
`lint` never throws. Parse errors, lint warnings, and structural findings come back in one list, each with a `code`, a `severity`, a `message`, and a `fix` when the linter has one.
The linter checks two different kinds of failure.

**The production limits.** The rules compiler enforces hard caps: a 256 KB source ceiling, a boolean chain depth of 98, 11 `let` bindings per function, `get()` call counts, and a runtime evaluation budget that fails as a silent `permission-denied` under load. The linter carries each cap as an exact threshold, measured by probing the production engine. The numbers live in [the measured Firestore Rules limits](./firestore-rules-limits.md).

**JS-in-rules mistakes.** The rules language looks like JavaScript, and that resemblance is a trap. Models fall into it constantly, and humans do too.

Code like `resource.data.tags.includes('x')` parses fine and then fails at runtime as a bare `permission-denied`. The linter knows the specific ways this goes wrong and maps each one to the rules-language fix:

| You wrote | The rules language wants |
|---|---|
| `list.includes(x)` | `x in list` |
| `.toLowerCase()` / `.toUpperCase()` | `.lower()` / `.upper()` |
| `.filter(...)` / `.map(...)` | nothing; lists are not transformable, restructure the logic |
| `.length` | `.size()`, a method with parentheses |
| `obj?.field` | `'field' in obj && obj.field` |
| `x => ...` | `function name() { return ...; }` |
| `a === b` | `a == b` |
| `Object.keys(data)` | `data.keys()` |
| `request.data` | `request.resource.data` |
| `undefined` | `null` |

Each of these emits a warning that names the mistake:
```
[HALLUCINATED_METHOD] `.includes()` does not exist in Firestore rules.
  Use `x in list` instead of `list.includes(x)`
```
The syntax-level catches (`===`, `?.`, `??`, arrow functions, backtick strings) fire even when the file fails to parse, because the parse error alone would point you at a stray parenthesis instead of the actual cause.

## Block shipping on Rules errors

Gate CI (and refuse to `firebase deploy`) when any issue has `severity: 'error'`:
```ts
const errors = lint(source).filter((issue) => issue.severity === 'error');
if (errors.length > 0) process.exit(1);
```
A hallucinated method is always an error, because the named method literally does not exist. Blocking on it is never a false alarm.

## Simulate and lint Realtime Database rules

Realtime Database rules use the same two steps with a different entry point. `rtdbRules` accepts the `{ rules }` JSON from `database.rules.json`, or a ruleset you wrote in TypeScript. See [write Realtime Database rules in TypeScript](./rtdb-rules-in-typescript.md) for the authoring side.

### Simulate a request
```ts
import { rtdbRules } from 'pyric/rules';

const rules = rtdbRules({
  rules: {
    '.read': false,
    '.write': false,
    records: {
      $recordId: {
        '.read': "auth != null && data.child('ownerId').val() === auth.uid",
        '.validate': "newData.hasChildren(['ownerId', 'title'])",
        '.write': 'auth != null',
        title: { '.validate': 'newData.isString() && newData.val().length <= 80' },
      },
    },
  },
});

const { cases } = rules.simulate([
  {
    description: 'a title over 80 characters is rejected',
    expectation: 'DENY',
    operation: 'write',
    path: '/records/r1',
    auth: 'alice',
    newData: { ownerId: 'alice', title: 'x'.repeat(81) },
  },
]);
```
Each result carries the `decision` (`ALLOW`, `DENY`, or `UNSUPPORTED`), whether it `passed`, and three fields that name what decided it:
```
matchedPath: /records/$recordId/title
matchedRule: newData.isString() && newData.val().length <= 80
reason:      Validation rule evaluated to false
```
`matchedPath` is the rule's location in the ruleset, so it shows the `$recordId` wildcard rather than the concrete path. `UNSUPPORTED` means the case reached an expression the simulator cannot evaluate. It abstains rather than guesses.

The result also carries a `trace` with every rule the simulator ran, in order:
```ts
for (const step of cases[0].trace) {
  console.log(`${step.path} .${step.kind} -> ${step.verdict}: ${step.conditionText}`);
}
```
```
/ .write -> DENY: false
/records/$recordId .write -> ALLOW: auth != null
/records/$recordId .validate -> ALLOW: newData.hasChildren(['ownerId', 'title'])
/records/$recordId/title .validate -> DENY: newData.isString() && newData.val().length <= 80
```
The cascade shows the root `.write` denying before the deeper rule grants, and the validate walk stops at the first failure. Each step also carries `pathVariableBindings`, here `{ $recordId: 'r1' }`. A rule that raises a runtime error has the verdict `ERROR` and the error in `message`.

The same simulation is on the command line. It reads the rules from a file and evaluates one request:
```bash
pyric rules simulate --service database --rules-file database.rules.json --operation read --path /records/r1 --uid alice
```
It prints the `decision`, `matchedPath`, `matchedRule`, `reason`, and `trace`, and each trace step carries the `line` of its rule key in the file. Pass the written value as JSON with `--data`. Without `--rules-file`, it evaluates against the rules the sandbox is running.

### Lint a ruleset
```bash
pyric rules lint --service database --rules-file database.rules.json
```
Or in code:
```ts
const issues = rules.lint();
```
Each issue has a `code`, a `severity`, a `message`, and the `path` it applies to. An issue about one rule also names its `rule` (`.read`, `.write`, or `.validate`). An issue about the shape of the ruleset has no `rule`.

The errors in the first group are the ones `firebase deploy` refuses, and each message is the text the deploy reports:

| Code | What it reports |
|---|---|
| `PARSE_ERROR` | The expression does not parse. |
| `NOT_BOOLEAN` | The rule does not evaluate to a boolean, such as a `.read` of `auth.uid`. |
| `INVALID_OPERAND` | An operator gets an operand type it does not take, such as `data.val() > true`, or `!` on a string. |
| `INVALID_ARGUMENT` | A method gets the wrong number or type of arguments, such as `child(1)`, or `matches()` with anything other than a regular expression literal. |
| `INVALID_REGEX` | A regular expression literal has a flag other than `i`. |
| `NO_SUCH_MEMBER` | The value has no such method or property, such as `data.nope()`. |
| `NOT_AN_OBJECT` | A property access on a number, boolean, null, or regular expression. |
| `NOT_A_FUNCTION` | A call on something that is not a method, such as `auth.uid()`. |
| `INVALID_PROPERTY_ACCESS` | An index with a computed key, `x[expr]`, on anything other than `auth`. |
| `UNEXPECTED_ARRAY` | An array literal anywhere other than the argument of `hasChildren()`. |
| `UNKNOWN_IDENTIFIER` | The variable is not available, such as a `$name` that no enclosing key declares. |
| `NEWDATA_IN_READ` | A `.read` rule uses `newData`, which exists only for writes. |
| `MULTIPLE_WILDCARDS` | One location has two `$` children. |
| `RULE_NOT_EXPRESSION` | A `.read`, `.write`, or `.validate` value is a number or a plain object rather than a boolean or a string. |
| `INDEX_ON_SHAPE` | `.indexOn` is a number. |
| `INVALID_KEY` | A key contains `#`, or an unknown key that starts with `.` holds an object. |
| `EXPECTED_OBJECT` | An unknown key that starts with `.`, or a child key, holds a string. |

`INDEX_ON_SHAPE` and `INVALID_KEY` are warnings, not errors, for related forms: any other `.indexOn` that is not a string or an array of strings, and a key that contains `.`, `/`, `[`, `]`, or an inner `$` but no `#`. Their text comes from the deploy's message for the related form, and no deploy of these forms has been recorded.

The second group is the rest of the per-rule checks:

| Code | Severity | What it means |
|---|---|---|
| `COMPILE_ERROR` | error | A TypeScript definition could not compile to rules JSON. |
| `HARDCODED_TRUE` | warning | A `.read` or `.write` rule is the literal `true`, so it grants every request at that location. |
| `HARDCODED_FALSE` | warning | A `.read` or `.write` rule is the literal `false`. This is often intentional, as in a locked root. |
| `DATA_IN_WRITE` | warning | A `.write` rule reads `data` but never `newData`, so it may not check the incoming value. |
| `CONSTANT_COMPARISON` | warning | A comparison between two literals, such as `'a' == 'b'`, which always has the same value. |

The third group reads the whole ruleset, because the common RTDB mistakes come from how rules at different depths combine. Each finding names the rule it sits on and carries a `fix`. Findings at the `critical` and `high` levels are reported as errors, and `medium` as warnings.

| Code | What it reports |
|---|---|
| `RTDB-SEC-1` | A `.write` of `true`, so anyone, signed in or not, can write, replace, or delete values under that path. |
| `RTDB-SEC-2` | A `.read` of `true`, so anyone can read everything under that path. At the root, this exposes the entire database. |
| `RTDB-SEC-3` | A conditional `.write` that never reads `auth`, so a signed-out client can write whenever the condition holds. |
| `RTDB-SEC-4` | A rule that tries to restrict access that an ancestor already grants. A deeper rule cannot revoke an ancestor's grant, so the deeper rule restricts nothing. |
| `RTDB-SEC-5` | A `.validate` that a delete skips. `.validate` runs only on a non-null new value, so a client that can write `null` at an ancestor bypasses it. |
| `RTDB-SEC-6` | A `.write` that accepts any value: no `.validate` sits at or below it and the write rule does not check `newData`. |
| `RTDB-SEC-7` | A node that names children in `.validate` but has no `$other` rule, so a write can add any other key under it. |

For a ruleset that names children in `.validate`, `"$other": { ".validate": false }` rejects the keys it does not name.

Lint a ruleset before you simulate it. `simulate` does not run the deploy check. A case that reaches an expression that does not parse comes back `UNSUPPORTED`, and a rule the deploy refuses can still evaluate: a `.read` of `auth.uid` grants any signed-in reader in the simulator, and production never loads that ruleset at all.

`pyric database rules validate database.rules.json` prints the errors in a file and exits with status 2 when it finds any. A finding about one rule includes the `line` and `column` of its rule key in the file, and comments in the file do not shift them.

### Know how the simulator evaluates rules

Three behaviors decide most surprising verdicts.

**Equality is strict.** `==` and `!=` compare without converting types, as the production rules engine does. `5 == '5'` and `1 == true` are both false, and `==` and `===` give the same answer. A `.validate` rule such as `newData.val() == '5'` accepts the string `'5'` and rejects the number `5`:
```
write /scores/a  newData '5'  ->  ALLOW
write /scores/a  newData 5    ->  DENY   Validation rule evaluated to false
```
A rule written against a loose-equality habit fails here the way it fails in production.

**A rule that errors does not grant.** A runtime error fails that rule. Calling `toUpperCase()` on a number is one. A `null` operand of an ordering or arithmetic operator is another, such as `data.child('n').val() > 1` when `n` does not exist. A `.validate` rule that errors rejects the write, and the reason names the error:
```
Validation rule at '/names/$id' failed at evaluation: Method 'toUpperCase' is not defined on number.
```
A `.read` or `.write` rule that errors does not grant access, and evaluation continues to the next rule on the path, as it does after a rule that evaluates to false. If no other rule grants, the request is denied. The case is a `DENY`, not `UNSUPPORTED`.

**Access cascades and validation does not.** The first `.read` or `.write` rule on the path from the root that evaluates to true grants the request, and a deeper rule cannot revoke it. A write also needs every `.validate` rule at and below the written path to pass.

### Keep the running sandbox in step with the file

`pyric sandbox` and the Vite plugin watch the Realtime Database rules file and reload it when it changes. They watch the path `firebase.json` names under `database`, or `database.rules.json` when it names none. They watch it whether or not the file exists yet:

- **Created.** A rules file you add after startup loads. Until then, Realtime Database follows its default policy: deny every client request, or allow when you start with `--permissive`.
- **Changed.** Saving the file loads the new rules and logs `rtdb rules reloaded`. A file that is not valid rules JSON, or that has a lint error from the first group above, does not replace the running rules. The last good ruleset stays live and the log reads `rtdb rules NOT reloaded (last-good stays live)` with the reason.
- **Deleted.** The sandbox returns to the default policy and logs `rtdb rules removed` with the path. A deleted Firestore rules file behaves differently: the last good Firestore rules stay in force and the log reports the deletion.

At startup, a rules file the deploy would refuse stops `pyric sandbox` with the same reason. The other load paths refuse it too: `pyric rules set --service database`, a seed's database rules, `pyric verify`, and `pyric database rules generate`, which writes nothing and exits with status 2. `sandbox.setRules` from `pyric/database` installs a ruleset as given, without this check.

Pass `--no-watch` to `pyric sandbox` to turn hot reload off for Firestore, Realtime Database, and Storage rules.

## Correct Rules through an agent

This is the loop that keeps an agent honest. It calls `firestore_lint_rules` on the rules it wrote, reads the fixes in the warnings, and corrects itself before anything deploys. Then `firestore_simulate_rules` confirms the behavior. [Work with an agent](../agent/work-with-an-agent.md) shows the task prompts that drive this loop.

## Where to go next

The exact numbers behind the limit checks are in [the measured Firestore Rules limits](./firestore-rules-limits.md). To make simulation a habit rather than a one-off, [write a rules test suite](./write-a-rules-test-suite.md).
