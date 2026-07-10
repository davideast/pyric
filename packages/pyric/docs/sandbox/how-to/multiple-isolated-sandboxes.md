# How to run multiple isolated sandboxes in parallel

Keep multiple sandboxes alive at once, for fleet tests, multi-tenant simulations, or any workload that needs more than one isolated environment.

## Sandboxes are fully isolated

Two `initializeSandbox()` calls produce two independent sandboxes. No shared state, no shared listeners, no shared event log. Run them in parallel without coordination:

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const sbA = initializeSandbox();
const sbB = initializeSandbox();

const dbA = getFirestore(sbA.withAuth({ uid: 'alice' }));
const dbB = getFirestore(sbB.withAuth({ uid: 'alice' }));

await Promise.all([
  dbA.collection('notes').doc('a1').set({ from: 'sandbox A' }),
  dbB.collection('notes').doc('b1').set({ from: 'sandbox B' }),
]);

console.log(sbA.admin.getDocument('notes/a1'));  // { from: 'sandbox A' }
console.log(sbB.admin.getDocument('notes/b1'));  // { from: 'sandbox B' }
console.log(sbA.admin.getDocument('notes/b1'));  // null — different sandbox
```

## Fleet test pattern

For N parallel scenarios:

```ts
async function runScenario(scenarioName: string) {
  const sandbox = initializeSandbox();
  // ... seed, run, assert
  sandbox.dispose();
}

await Promise.all(scenarios.map(runScenario));
```

Each scenario gets its own sandbox. `dispose` at the end is defensive. Once the variable goes out of scope, the garbage collector will reclaim the sandbox anyway. `dispose` matters when listeners are involved, because subscribers might keep the sandbox reachable longer than you intended.

## Cost considerations

Sandboxes are cheap in memory but not free. Each carries:

- A `LocalEnvironment` with its own document store, event log, and listener registries.
- A `SimulateFirestoreRulesHandler` instance (the rules-evaluation engine).
- Whatever subscribers you attached.

For thousands of sandboxes, profile before assuming linearity. For tens or hundreds, treat them as free.

## Sharing rules across sandboxes

`SandboxConfig` is reserved for future bulk-config options. Today, each sandbox sets rules independently. To share a ruleset across many:

```ts
const RULES = `rules_version = '2'; …`;

function makeSeeded() {
  const sandbox = initializeSandbox();
  const admin = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
  admin.setRules(RULES);
  return sandbox;
}

const sandboxes = Array.from({ length: 10 }, makeSeeded);
```

The rules text is shared (by reference); the underlying state is per-sandbox.

## Vitest / Bun test parallelism

Test runners that run files in parallel processes (Vitest, Bun's default) handle isolation automatically. Each test file gets its own process with its own module state. Sandboxes created in different files cannot leak into each other.

Test runners that share a process across files (Vitest with `fileParallelism: false`, Jest with `--runInBand`) need per-test sandboxes if tests within the same file might run concurrently. The default per-file isolation usually suffices.

## Don't reach across sandboxes

Sandboxes are not meant to be cross-referenced. A `SandboxContext` is bound to a specific sandbox; passing a context built from `sbA` to a service handle constructed against `sbB` is undefined behaviour. The `instanceof SandboxContextImpl` check in service factories catches gross mismatches, but the package does not police context-to-sandbox identity beyond that.

If your scenario needs cross-sandbox state transfer, do it explicitly: `sbA.snapshot()` to capture, write back into `sbB` via admin or seed.

## Where to look next

- For the cost-model rationale, see [Why this package exists](../explanation/why-this-package-exists.md).
- For multi-tenant test patterns, see [Use the sandbox in a test harness](../tutorials/02-use-the-sandbox-in-a-test-harness.md).
