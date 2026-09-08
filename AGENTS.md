# AGENTS.md

## Priorities are law

`PRIORITIES.md` names this repo's current priorities, each with a one-sentence test.
Judge every piece of proposed work — the user's and your own — against those tests before starting it.
Work that passes proceeds without comment. Work that fails every test gets the `/wrist-slap-me` treatment: slap first, then the exits.

## Implementation Completeness (Beyond Local Oracles)

Passing a unit test or MRE oracle is necessary but not sufficient. Before opening a PR or marking a requirement complete, verify six integration boundaries:

1. **Full-Lifecycle Propagation:** A new property or claim (e.g., `auth.tenantId`) is not done when it reads back from the setter. Trace and test its flow through operations (`signIn*`), resulting handles (`user.tenantId`), and downstream enforcement (Security Rules context).
2. **Algebraic & Short-Circuit Composition:** In rules evaluators, type or runtime failures must produce first-class error values (`RuleError`) that participate in CEL/Rules commutative error absorption (`error || true`, `error && false`), never raw host booleans or generic strings.
3. **Dual-Plane Parity (Sandbox + Worker Bridge):** Any SDK surface or return-shape change in `packages/pyric/src/` must also be checked against the CLI/Studio worker protocol in `packages/cli/src/serve/`.
4. **Foundation Reuse (`pyric/sandbox/internal`):** Never duplicate cross-service logic (auth normalization, path canonicalization, error shapes) inside a single service package. Reuse or extend the shared sandbox foundation.
5. **Cross-Runtime Fallback Verification:** In dual-runtime utilities (e.g., `typeof Buffer === 'function'` vs. browser `btoa`), `bun test` only hits the Node/Bun branch by default. Explicitly test the browser/worker branch by temporarily deleting the Node global (e.g., `delete (globalThis as any).Buffer`) and asserting parity across boundary cases (empty payloads, padding remainders).
6. **Conformance Registry Total-Count Invariant:** Any addition or removal of rows in `packages/conformance/registry/*.ts` shifts the global `assuranceNodeVerdicts` count enforced by `packages/conformance/test/src/conformance-model.test.ts`. Run that test and update the expected count whenever registry rows change.

