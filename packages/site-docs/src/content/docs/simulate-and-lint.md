---
title: "Simulate and lint rules before deploying"
navLabel: "Simulate and lint before deploying"
group: "Secure & debug"
section: ""
order: 3002
description: "Get a rules verdict and a lint report locally, before production answers with an unexplained 400 or 403."
---

# Simulate and lint rules before deploying

A broken ruleset fails late: a `400` at deploy time, or a `403` at runtime. Pyric moves both failures to your machine, before the deploy.

Simulation tells you what a rule decides. Linting tells you what the production compiler and runtime will reject, and why, in the language of the mistake you made.

## Simulate a request from the command line

Feed the rules source and one or more cases to the simulator on stdin. It runs in-process, no network, no project. Put the request in a JSON file:

```json
{
  "source": "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /notes/{noteId} {\n      allow read: if request.auth != null;\n    }\n  }\n}",
  "testCases": [
    {
      "description": "unauthenticated read is denied",
      "expectation": "DENY",
      "method": "get",
      "path": "notes/n1"
    }
  ]
}
```

Then pipe it in:

```bash
pyric rules:simulate --stdin < request.json
```

Each case reports `PASSED`, `FAILED`, or `UNSUPPORTED`, and each carries a trace naming the rule that decided:

```
Rule #0 (read) → deny
Simulated: DENY
```

`UNSUPPORTED` means the simulator hit a feature it does not implement and abstained rather than guessed. Those cases can be escalated to Google's own engine through `pyric verify --engine rules-test-api`. See [write a rules test suite](../write-a-rules-test-suite/).

The same simulator is available in code. Compile the source once, then run the cases:

```ts
import { firestoreRules } from 'pyric/rules';

const summary = firestoreRules(source).simulate([
  {
    description: 'unauthenticated read is denied',
    expectation: 'DENY',
    method: 'get',
    path: 'notes/n1',
  },
]);
console.log(`${summary.passed} passed, ${summary.failed} failed`);
```

`simulate` never throws on a rule outcome. It returns a `SimulationSummary` (`passed`, `failed`, `unsupported`, and a `cases` array), so a denied or abstained case is data you read, not an exception you catch. The same simulator evaluates every operation inside your running sandbox.

## Lint before the compiler rejects the rules

```bash
pyric rules:lint firestore.rules
```

Or in code. The tolerant `lint` function accepts any source, never throws, and returns one flat list of issues:

```ts
import { lint } from 'pyric/rules';

const issues = lint(source);
```

Each `RuleIssue` carries a `code`, a `severity` of `'error' | 'warning' | 'info'`, a `message`, and often a `fix`. The linter checks two different kinds of failure.

**The production limits.** The rules compiler enforces hard caps: a 256 KB source ceiling, a boolean chain depth of 98, 11 `let` bindings per function, `get()` call counts, and a runtime evaluation budget that fails as a silent `permission-denied` under load. The linter carries each cap as an exact threshold, measured by probing the production engine. The numbers live in [the compiler and evaluator limits](../limits-that-bite/).

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

Each of these emits an issue whose `message` names the mistake and whose `fix` carries the correction:

```
[HALLUCINATED_METHOD] `.includes()` does not exist in Firestore rules.
  Use `x in list` instead of `list.includes(x)`
```

The syntax-level catches (`===`, `?.`, `??`, arrow functions, backtick strings) fire even when the file fails to parse, because the parse error alone would point you at a stray parenthesis instead of the actual cause.

## Let the errors block the deploy

Every issue carries a severity. `pyric deploy rules` refuses to ship a ruleset with any `error`-severity finding, and you can mirror that gate in CI:

```ts
const errors = lint(source).filter((i) => i.severity === 'error');
if (errors.length > 0) process.exit(1);
```

A hallucinated method is always an error, because the named method literally does not exist. Blocking on it is never a false alarm.

## Self-correct rules with lint from an agent

This is the loop that keeps an agent honest. It runs `lint` on the rules it wrote, reads the `fix` on each issue, and corrects itself before anything deploys. Then a `simulate` run confirms the behavior. The mistakes the linter catches are, in large part, the mistakes models make. See [what your agent can do](../skills/).

## Where to go next

The exact numbers behind the limit checks are in [the compiler and evaluator limits](../limits-that-bite/). To make simulation a habit rather than a one-off, [write a rules test suite](../write-a-rules-test-suite/).
