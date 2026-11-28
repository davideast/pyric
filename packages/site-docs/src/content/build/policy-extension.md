---
title: "Write unified policies with the experimental extension"
navLabel: "Policy extension"
group: "Build"
section: ""
order: 70
description: "Author one Rules-based policy for Firestore, Storage, Realtime Database, and Fetch gateways, prove cross-engine parity, and drive closed-loop repairs."
---

# Write unified policies with the experimental extension

`@pyric/rules/experimental/policy` is an opt-in entry point for authoring one Rules-v2-based policy and enforcing it across database rules, standalone ES modules, and HTTP host boundaries. Standard Security Rules loaders never import this grammar.

## Unified dialect and extensions

One parser (`parsePolicyIR`) and static checker (`checkPolicyIR`) handle three program kinds, auto-detected by `detectPolicyKind(source)`:

| Kind | Entry shape | Source cap | Allowed `use extension` imports | Max bounded limit |
| --- | --- | --- | --- | --- |
| `transition` | `transition name { derive? require+ }` | 8,192 chars | `bounded`, `derive`, `methods` | `400` |
| `function` | Single `function name(...) { ... }` | 8,192 chars | `bounded`, `loops` (`loops` alone for `for...of`) | `400` |
| `module` | One or more `export? function` | 32,768 chars | `bounded` (required), `loops` | `4096` |

Key static and runtime invariants:

- **Opt-in extensions:** declare `use extension bounded;`, `use extension derive;`, `use extension loops;`, or `use extension methods;` at the top of the file.
- **Acyclic call graph:** helper functions must form a strict DAG; recursive calls are rejected during static checking.
- **Bounded collection ops (`bounded`):** `bounded.map`, `bounded.flatMap`, `bounded.select`, `bounded.any`, `bounded.all`, `bounded.count`, `bounded.fold`, and `bounded.append`. Exceeding an iteration cap returns a fatal `resource-limit` failure instead of silently truncating.
- **Rules-v2 value model:** integer literals follow signed 64-bit (`int64`) range checks. Keep financial totals in integer cents and basis points (`(amount * bps) / 10000`) to avoid floating-point rounding drift.
- **Expression budget:** `expressionLimit` defaults to `8192` and accepts integers from `1` to `32768`.
- **Transitions:** requirements read `before`, `after`, `input`, and (when declared) `derived` from the `derive { ... return { ... }; }` block.

```rules
use extension derive;
use extension bounded;

transition purchaseOrderSubmit {
  derive {
    let subtotal = bounded.fold(input.items, 0, (acc, item) => acc + item.qty * item.unitCents, 12);
    let fee = (subtotal * before.feeBps) / 10000;
    return {'subtotalCents': subtotal, 'feeCents': fee, 'totalCents': subtotal + fee};
  }
  require authenticatedTenant {
    return input.auth != null
      && input.tenant == before.tenantId
      && after.tenantId == before.tenantId;
  }
  require validLineItems {
    let ok = bounded.all(
      input.items,
      item => item.qty is int && item.qty > 0 && item.unitCents is int && item.unitCents >= 0,
      12
    );
    return ok;
  }
  require derivedTotalMatches {
    return after.totalCents == derived.totalCents
      && after.totalCents <= before.budgetLimitCents;
  }
}
```

## Compilation targets

A compiled transition (`compilePolicy(source, { expressionLimit })`) reports which requirements lower natively to each Firebase target and which remain gateway residuals:

| Target | Report method | Default mode | Module / composition helper |
| --- | --- | --- | --- |
| Cloud Firestore | `policy.firestore(bindings, mode)` | `'complete'` | `policy.firestoreModule(bindings)`, `policy.bind.firestore({ rules, slot, placements })` |
| Cloud Storage | `policy.storage(bindings, mode)` | `'complete'` | `policy.storageModule(bindings)`, `policy.bind.storage({ rules, slot, placements })` |
| Realtime Database | `policy.rtdb(bindings, mode)` | `'mixed'` | `policy.bind.rtdb({ path, bindings, mode }).verify(tree)` |
| Standalone ES module | `policy.standaloneModule()` | N/A | Zero-dependency JS module (`emitStandaloneModule`, `compileBoundedModule`) |

For `bind.firestore` and `bind.storage`, declare a zero-argument root slot function returning `false` and reference it as a direct conjunct (`&&`) on a single-verb `allow` rule. The composer rejects shadowed slots, disjunctions, negations, and duplicate grants covering the same operation.

```ts
import { compilePolicy } from '@pyric/rules/experimental/policy';

const rbac = compilePolicy(`
transition tenantDocUpdate {
  require tenantIsolation {
    return input.auth != null
      && input.tenant == before.tenantId
      && after.tenantId == before.tenantId
      && input.pathTenant == before.tenantId;
  }
  require roleFloor {
    return input.roleRank is int
      && before.minWriteRank is int
      && input.roleRank >= before.minWriteRank;
  }
}
`);

const template = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{db}/documents {',
  '    function rbacPolicy() { return false; }',
  '    match /tenants/{tenantId}/docs/{docId} {',
  '      allow update: if rbacPolicy();',
  '    }',
  '  }',
  '}',
].join('\n');

const { rules } = rbac.bind.firestore({
  rules: template,
  slot: 'rbacPolicy',
  placements: [{
    path: '/databases/{db}/documents/tenants/{tenantId}/docs/{docId}',
    operation: 'update',
    bindings: {
      'input.auth': 'request.auth',
      'input.tenant': 'request.auth.token.tenantId',
      'input.pathTenant': 'tenantId',
      'input.roleRank': 'request.auth.token.roleRank',
      'before.tenantId': 'resource.data.tenantId',
      'after.tenantId': 'request.resource.data.tenantId',
      'before.minWriteRank': 'resource.data.minWriteRank',
    },
  }],
});

if (!rules.includes('request.auth.token.tenantId')) {
  throw new Error('Expected lowered tenant binding in Firestore rules');
}
```

Cloud Storage policies bind `input.auth` to `request.auth`, path wildcards directly by name (for example `'input.pathUid': 'uid'`), `before` to `resource`, and `after` to `request.resource`. Realtime Database policies bind `before` to `'data'` and `after` to `'newData'` (or `{ snapshot, parent, path, type }`) and verify the emitted `.validate` conjunct with `policy.bind.rtdb(...).verify(tree)`.

### Loading standalone ES modules safely

For portability across Bun 1.3.11+ and Node 22/24, write `standaloneModule().moduleSource` to a temporary `.mjs` file and import it via `pathToFileURL`. Avoid `data:text/javascript;base64,...` dynamic imports. For isomorphic in-memory instantiation with zero Node imports, use `instantiateStandaloneModule(moduleSource)`.

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compilePolicy } from '@pyric/rules/experimental/policy';

const policy = compilePolicy(`
transition step {
  require nextCount {
    return before.count is int && after.count is int && after.count == before.count + 1;
  }
}
`);

const dir = mkdtempSync(join(tmpdir(), 'pyric-policy-doc-'));
try {
  const modPath = join(dir, 'step.mjs');
  writeFileSync(modPath, policy.standaloneModule().moduleSource, 'utf8');
  const mod = await import(pathToFileURL(modPath).href);
  const verdict = mod.judge({ before: { count: 4 }, after: { count: 5 }, input: {} });
  if (!verdict.ok) throw new Error('Expected valid increment');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

## Proving policies with `provePolicy()`

`provePolicy(source, options)` is isomorphic (no Node-only imports) and combines static IR checking, standalone module verification, placement and expression-cost diagnostics, scenario replay, and deterministic seeded differential fuzzing into one JSON-serializable `PolicyProofReport`.

```ts
import { provePolicy } from '@pyric/rules/experimental/policy';

const report = provePolicy(
  `
  transition nextStep {
    require increment {
      return before.count is int && before.count >= 0 && before.count <= 9007199254740991
        && after.count is int && after.count >= 0 && after.count <= 9007199254740991
        && after.count == before.count + 1;
    }
  }
  `,
  {
    firestore: {
      'before.count': 'resource.data.count',
      'after.count': 'request.resource.data.count',
    },
    rtdb: {
      'before.count': 'data',
      'after.count': 'newData',
    },
    scenarios: [
      { name: 'allow +1', transition: { before: { count: 1 }, after: { count: 2 }, input: {} }, expectOk: true },
      { name: 'deny +2', transition: { before: { count: 1 }, after: { count: 3 }, input: {} }, expectOk: false, expectRequirement: 'increment' },
    ],
    fuzz: { seed: 42, cases: 64, includeAdversarial: true },
  },
);

if (!report.ok || report.fuzz.divergences.length > 0) {
  throw new Error('Policy proof failed');
}
```

### Structured traces and placement reason codes

When `judge()` denies a transition, `verdict.trace` contains bounded, JSON-serializable diagnostics:

- `requirement`, `span` (`{ line, col, location }`), `source`
- `outcome`: `'false'`, `'eval-error'`, or `'resource-limit'` (with `fatal: true` for `'resource-limit'`)
- `bindings`: evaluated `let` bindings across `derive` and `require` scopes
- `failingSubExpression`: deepest falsifying or erroring expression node with evaluated `operands`
- `derived`: evaluated `derive` map (or `{ $error }` if derivation threw)
- `expressionUnitsUsed` and `expressionLimit`

Each row in `placement.firestore` and `placement.rtdb` includes an `ExpressionCostBreakdown` (`sourceUnits`, `targetUnits`, `withinSourceBudget`, `withinTargetBudget`, `boundedOps`) and machine-readable `diagnostics` carrying a `PlacementReasonCode`:

`LOWERED`, `USES_BOUNDED_OP`, `USES_DERIVE`, `USES_DERIVE_COLLECTION`, `USES_HELPER_FUNCTIONS`, `USES_LOCAL_BINDINGS`, `MISSING_BINDING`, `WRONG_SNAPSHOT_ORIGIN`, `UNTRUSTED_DERIVE_INPUT`, `PROJECTION_BUDGET_EXCEEDED`, `EXPRESSION_BUDGET_EXCEEDED`, `UNSUPPORTED_EXPRESSION`, `UNVERIFIED_DERIVE_SIBLINGS`, `INVALID_BINDING_PROJECTION`, `LOOP_NOT_LOWERABLE`.

## Host boundaries with `createPolicyGuard()`

When a policy contains gateway residuals (such as `derive` or `bounded.fold`), split enforcement lets one policy govern both layers with zero drift: lower the pure requirements to Firestore/RTDB/Storage rules in `'mixed'` mode, and wrap your Fetch / Next.js Route Handler or Cloud Functions HTTP handler with `createPolicyGuard()` before committing via the Admin SDK.

```ts
import { createPolicyGuard, jsonBodyExtractor, PolicyDeniedError } from '@pyric/rules/experimental/policy';

const guard = createPolicyGuard(
  `
  use extension derive;
  use extension bounded;

  transition checkout {
    derive {
      let subtotal = bounded.fold(input.items, 0, (acc, x) => acc + x.qty * x.unitCents, 12);
      return {'totalCents': subtotal};
    }
    require exactTotal {
      return after.totalCents == derived.totalCents && after.tenantId == before.tenantId;
    }
  }
  `,
  {
    engine: 'standalone',
    attachDigestHeader: true,
    includeTraceInResponse: false,
    denyStatus: 403,
    fatalStatus: 422,
  },
);

export const POST = guard.wrapFetch(
  jsonBodyExtractor({ maxBodyBytes: 65536 }),
  async (_req, verified) => {
    return new Response(
      JSON.stringify({ ok: true, totalCents: verified.derived?.totalCents }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  },
);

const okRes = await POST(
  new Request('https://app.example/api/checkout', {
    method: 'POST',
    body: JSON.stringify({
      before: { tenantId: 'acme' },
      after: { tenantId: 'acme', totalCents: 2500 },
      input: { items: [{ qty: 2, unitCents: 1000 }, { qty: 1, unitCents: 500 }] },
    }),
  }),
);
if (okRes.status !== 201 || !okRes.headers.get('x-policy-digest')) {
  throw new Error('Expected 201 with x-policy-digest header');
}

let denied = false;
try {
  guard.assert({
    before: { tenantId: 'acme' },
    after: { tenantId: 'acme', totalCents: 100 },
    input: { items: [{ qty: 1, unitCents: 500 }] },
  });
} catch (err) {
  denied = err instanceof PolicyDeniedError && err.requirement === 'exactTotal';
}
if (!denied) throw new Error('Expected PolicyDeniedError');
```

Guard defaults and options:

- **Zero Node imports:** uses Web-standard `Request`, `Response`, `URL`, `TextEncoder`, `Uint8Array`, and `crypto.subtle`.
- **Engines:** `'interpreter'` (default) or `'standalone'`.
- **Safe trace exposure:** `includeTraceInResponse` defaults to `false` so internal binding traces are not leaked to external callers unless explicitly enabled.
- **Input hardening:** `jsonBodyExtractor()` enforces streaming `maxBodyBytes` (returning `413` `POLICY_PAYLOAD_TOO_LARGE` via `PolicyPayloadTooLargeError`) and rejects own `__proto__`, `constructor`, and `prototype` keys (`400` `POLICY_BAD_REQUEST`).
- **HTTP adapters:** `wrapFetch()` targets Fetch / Next.js Route Handlers; `wrapHttpHandler()` targets Express / Cloud Functions `(req, res)` handlers; `check()`, `assert()`, and `derive()` support optimistic client checks.
- **Digest pinning:** `attachDigestHeader: true` adds `x-policy-digest` (SHA-256 hex of the policy source).

## CLI proving loop (`pyric policy`)

The companion `pyric policy` CLI exposes three subcommands (pass `-` as `<file>` to read stdin) with single-document `--json` output on stdout (including exit `1`):

- `pyric.policy.check.v1`: `{ schema, command, ok, exitCode, file, kind, mode, staticCheck, diagnostics, placement, cost, standalone }`
- `pyric.policy.prove.v1`: adds `scenarios` (with per-case `failureTrace`), `fuzz`, and `counterexamples`
- `pyric.policy.emit.v1`: adds `name`, `outDir`, `dryRun`, `targets`, `manifestPath`, and `artifacts`
- `pyric.policy.v1`: usage error emitted before a valid subcommand is parsed

```bash
# Static IR check, placement split, and expression-cost breakdown
pyric policy check policy.rules \
  --firestore-bindings firestore.bindings.json \
  --mode mixed --json

# Static check + scenario replay + seeded differential fuzzing
pyric policy prove policy.rules \
  --firestore-bindings firestore.bindings.json \
  --scenarios scenarios.json \
  --seed 42 --fuzz-cases 100 --json

# Emit native rules alongside a standalone ES module in one step
pyric policy emit policy.rules \
  --out-dir dist/policy \
  --firestore-bindings firestore.bindings.json \
  --storage-bindings storage.bindings.json \
  --rtdb-bindings rtdb.bindings.json \
  --rtdb-path /presence/\$uid --json
```

Common flags across `check`, `prove`, and `emit`: `--kind <transition|function|module>`, `--expression-limit <n>`, `--config <file>`, `--firestore-bindings <file>`, `--storage-bindings <file>`, `--rtdb-bindings <file>`, `--mode <mixed|complete>` (defaults to `mixed` for `check`/`prove`, `complete` for `emit`), and `--json`.

- `prove` adds `--scenarios <file>`, `--seed <n>` (default `1337`), `--fuzz-cases <0..2000>` (default `64`), `--max-duration-ms <100..60000>` (default `10000`), `--no-fuzz`, `--no-adversarial`, and `--no-esm-verify` (by default `prove` verifies the emitted module via a temp `.mjs` file and `pathToFileURL`). `--storage-bindings` populates `placement.storage` static lowering while scenario/fuzz parity runs against interpreter, standalone, Firestore, and RTDB.
- `emit` adds `--out-dir <dir>` (required unless `--no-write`), `--name <stem>`, `--targets <csv>` / `--target <target>`, `--firestore-template <file>`, `--storage-template <file>`, `--rtdb-path <path>`, `--manifest <file>`, `--no-standalone`, `--no-write`, and `--no-esm-verify`. Output files are staged in memory before writing (`complete`-mode failures write zero files): `<name>.mjs`, `<name>.firestore.rules` (and `<name>.firestore.module.rules` when both template and bindings are given), `<name>.storage.rules` (and `<name>.storage.module.rules`), and `<name>.rtdb.rules.json`.

Deterministic exit codes (echoed in JSON `exitCode`):

| Exit code | Meaning |
| --- | --- |
| `0` | Success (`check`, `prove`, or `emit` passed) |
| `1` | CLI usage, input validation, file I/O, or loader error |
| `2` | Syntax or static-check error (missing extension, recursive call, out-of-range int64) |
| `3` | Placement residual in `complete` mode, template composition error, or standalone/target emit failure |
| `4` | Proof failure (scenario expectation mismatch or cross-engine parity divergence; `prove` only) |

## Closed-loop repair workflow

Developers and coding agents can repair broken policies deterministically from JSON reports:

1. Run `pyric policy prove <file> --scenarios <file> --json` (or `provePolicy()`).
2. If `staticCheck.ok` is `false`, patch the syntax error, missing `use extension` import, or call cycle reported in `diagnostics[]` / `staticCheck.error`.
3. If a target row fails lowering, inspect `placement.<target>.rows[].diagnostics[].code` in the CLI JSON (or `placement.<target>[].diagnostics[].code` from `provePolicy()`), for example `WRONG_SNAPSHOT_ORIGIN` when `after.*` is bound to `resource.data.*`, or `MISSING_BINDING`.
4. If a scenario fails, inspect `counterexamples[]` / `scenarios.results[].failureTrace` in the CLI JSON (or `scenarios.results[].interpreter.trace` from `provePolicy()`): use `span.line` to locate the requirement, `bindings` and `derived` to check intermediate values, and `failingSubExpression.operands` to pinpoint the exact comparison or off-by-one operator.
5. Apply the minimal fix and re-run `prove` until `ok: true` with `scenarios.failed === 0` and `fuzz.divergences.length === 0`.

## Real-world reference suites

Six non-game reference suites live under `experiments/policy-oracle/suites/real-world/` (each pinned with `adapters/_shared/v1/` and mutant-killing checks):

| Suite | Domain | Primary target / features |
| --- | --- | --- |
| `multi-tenant-rbac` | Tenant isolation, role/rank hierarchy, archive lock | Firestore `bind.firestore()` |
| `saas-billing` | Seat quotas, basis-point discounts/tax in integer cents | `derive` + `bounded.fold` |
| `approval-workflow` | Document quorum, distinct reviewers, separation of duties | `bounded.all`, `bounded.count`, `bounded.any` |
| `storage-media-gate` | Path wildcards, MIME allowlist, tiered size ceiling, metadata | Storage `bind.storage()` + `methods` |
| `rtdb-rate-presence` | Presence state machine, monotonic heartbeat, window rate limit | RTDB `rtdb()` + `bind.rtdb().verify()` |
| `split-enforcement` | Purchase-order submit across Fetch gateway + Firestore rules | `createPolicyGuard()` + mixed-mode lowering |

## Related guides

- [Run Cloud Firestore locally](cloud-firestore.md)
- [Run Cloud Storage locally](cloud-storage.md)
- [Run Realtime Database locally](realtime-database.md)
- [Simulate and lint rules](../secure/simulate-and-lint.md)
- [Read a denial](../secure/read-a-denial.md)
- [Firestore rules limits](../secure/firestore-rules-limits.md)
