# `pyric/rules`

Pyric-native Firestore Security Rules tooling. A browser-safe parser, linter, modules resolver, in-process simulator, and Rules Test API client, packaged so the data-plane swap-in (`pyric/firestore`) stays minimal.

The surface is grouped around the things you can do with a rules source:

- **Parse** it into a typed AST you can walk.
- **Lint** it for compilation limits, runtime-budget risks, and known agent failure modes.
- **Validate** it for security and quality findings (`SEC-1` … `STR-3`).
- **Resolve** `2+modules` imports against a stdlib of reusable functions.
- **Simulate** it locally against test cases. No network, no propagation wait.
- **Test** it against the live Firebase Rules Test API.
- **Wrap** it in agent-tool factories for `@inbrowser/agent` registries.

Parse, Lint, Validate, Simulate, and Test all sit behind the public front door: `firestoreRules`, `rtdbRules`, `lint`, `eachCase`, `assertCase`, and `explainCase`. The parser, linter, validator, simulator, modules resolver, and agent-tool factories are internal engine seams, exposed only under `pyric/rules/internal*` for callers that need them directly. They may change without notice.

## Install

```bash
bun add pyric
# or
npm install pyric
```

## A 30-second example

```ts
import { firestoreRules } from 'pyric/rules';

const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == resource.data.ownerId;
    }
  }
}`;

const ruleset = firestoreRules(source);
console.log(ruleset.lint()); // []

const { passed, failed } = ruleset.simulate([
  {
    description: 'authed read is allowed',
    expectation: 'ALLOW',
    method: 'get',
    path: 'notes/n1',
    auth: { uid: 'alice' },
  },
]);
console.log(passed, failed); // 1 0
```

`firestoreRules(source)` throws `RulesCompileError` if the source doesn't parse. `simulate` never throws on rule outcomes; failures and unsupported cases come back in the result, not as exceptions.

The RTDB constraints DSL (`defineRtdbRules`, `ruleset`, `schemaRules`, and the combinators) is public and lives on the same root entry:

```ts
import { rtdbRules, defineRtdbRules, ruleset, allow } from 'pyric/rules';
```

The parser, validator, simulator internals, modules resolver, and agent-tool factories live on `pyric/rules/internal` and `pyric/rules/internal/node`. They're not part of the public contract:

```ts
import { resolveModules, createFirestoreRulesTools } from 'pyric/rules/internal/node';
```

## Where to go next

Documentation is organised under [`docs/`](./docs/) following the [Diataxis](https://diataxis.fr/) framework:

| If you want to | Read |
|---|---|
| Learn the package by following a complete lesson | [Tutorials](./docs/tutorials/) |
| Accomplish a specific task | [How-to guides](./docs/how-to/) |
| Look up an exact symbol, lint rule, or schema | [Reference](./docs/reference/) |
| Understand why the package is shaped this way | [Explanation](./docs/explanation/) |

### Starting points by role

- **First time here?** Work through [Lint your first rules file](./docs/tutorials/01-lint-your-first-rules-file.md), then [Write a test suite for your rules](./docs/tutorials/02-write-a-test-suite-for-your-rules.md).
- **Building an agent or CLI?** See [Register rules tools with an agent](./docs/how-to/register-tools-with-an-agent.md) and the [API reference](./docs/reference/api.md).
- **Triaging a lint warning?** Jump to [Lint rules reference](./docs/reference/lint-rules.md).
- **Debugging an `UNSUPPORTED` test result?** Read [Simulator vs Rules Test API](./docs/explanation/simulator-vs-rules-test-api.md).

## Position in the Pyric stack

`pyric/rules` is the **rules-tooling** sibling of `pyric/firestore` (the modular Web-SDK swap-in). The split is deliberate: the data-plane swap-in must mirror the production Firestore surface and nothing more. Anything that is *about* rules (parsing them, linting them, simulating them) lives here. See [Why this package exists](./docs/explanation/why-this-package-exists.md) for the longer story.

## Licence

Same as the parent workspace.
