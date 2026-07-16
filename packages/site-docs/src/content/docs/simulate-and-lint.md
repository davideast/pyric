---
title: "Catch the error before Firebase's opaque 400"
navLabel: "Simulate and lint before you deploy"
group: "Inspect and correct"
section: "Correct Security Rules"
order: 3006
description: "Get a rules verdict and a lint report locally, before production answers with an unexplained 400 or 403."
---

# Catch the error before Firebase's opaque 400

A broken ruleset fails late: a `400` at deploy time, or a `403` at runtime. Pyric moves both failures to your machine, before the deploy.

Simulation tells you what a rule decides. Linting tells you what the production compiler and runtime will reject, and why, in the language of the mistake you made.

## Simulate a hypothetical request

Ask the simulator whether a specific request would be allowed. It runs in-process, no network, no project:

```ts
import { SimulateFirestoreRulesHandler } from 'pyric/rules';

const sim = new SimulateFirestoreRulesHandler();
const result = sim.simulate(source, [
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

`UNSUPPORTED` means the simulator hit a feature it does not implement and abstained rather than guessed. Those cases can be routed to Google's own engine. See [write a rules test suite](../write-a-rules-test-suite/).

The same simulator is on the command line as `pyric firestore rules simulate`, and it is what evaluates every operation inside your running sandbox.

## Lint before the compiler can reject you

```bash
pyric firestore rules lint firestore.rules
```

Or in code:

```ts
import { lintFirestoreRules } from 'pyric/rules';

const { warnings, metrics } = lintFirestoreRules(source);
```

The linter checks two different kinds of failure.

**The production limits.** The rules compiler enforces hard caps: a 256 KB source ceiling, a boolean chain depth of 98, 11 `let` bindings per function, `get()` call counts, and a runtime evaluation budget that fails as a silent `permission-denied` under load. The linter carries each cap as an exact threshold, measured by probing the production engine. The numbers live in [the limits that actually bite](../limits-that-bite/).

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

## Let the errors block the ship

Warnings carry a severity. Gate CI (and refuse to `firebase deploy`) when any finding has `severity: 'error'`:

```ts
const errors = lintFirestoreRules(source).warnings
  .filter((w) => w.severity === 'error');
if (errors.length > 0) process.exit(1);
```

A hallucinated method is always an error, because the named method literally does not exist. Blocking on it is never a false alarm.

## And from an agent

This is the loop that keeps an agent honest. It calls `firestore_lint_rules` on the rules it wrote, reads the fixes in the warnings, and corrects itself before anything deploys. Then `firestore_simulate_rules` confirms the behavior. The mistakes the linter catches are, in large part, the mistakes models make. See [what your agent can do](../skills/).

## Where to go next

The exact numbers behind the limit checks are in [the limits that actually bite](../limits-that-bite/). To make simulation a habit rather than a one-off, [write a rules test suite](../write-a-rules-test-suite/).
