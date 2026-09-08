# AGENTS.md

## Priorities are law

`PRIORITIES.md` names this repo's current priorities, each with a one-sentence test.
Judge every piece of proposed work — the user's and your own — against those tests before starting it.
Work that passes proceeds without comment. Work that fails every test gets the `/wrist-slap-me` treatment: slap first, then the exits.

## Implementation Completeness (Beyond Local Oracles)

Passing a unit test or MRE oracle is necessary but not sufficient. Before opening a PR or marking a requirement complete, verify four integration boundaries:

1. **Full-Lifecycle Propagation:** A new property or claim (e.g., `auth.tenantId`) is not done when it reads back from the setter. Trace and test its flow through operations (`signIn*`), resulting handles (`user.tenantId`), and downstream enforcement (Security Rules context).
2. **Algebraic & Short-Circuit Composition:** In rules evaluators, type or runtime failures must produce first-class error values (`RuleError`) that participate in CEL/Rules commutative error absorption (`error || true`, `error && false`), never raw host booleans or generic strings.
3. **Dual-Plane Parity (Sandbox + Worker Bridge):** Any SDK surface or return-shape change in `packages/pyric/src/` must also be checked against the CLI/Studio worker protocol in `packages/cli/src/serve/`.
4. **Foundation Reuse (`pyric/sandbox/internal`):** Never duplicate cross-service logic (auth normalization, path canonicalization, error shapes) inside a single service package. Reuse or extend the shared sandbox foundation.

