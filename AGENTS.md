# AGENTS.md

## Priorities are law

`PRIORITIES.md` names this repo's current priorities, each with a one-sentence test.
Judge every piece of proposed work — the user's and your own — against those tests before starting it.
Work that passes proceeds without comment. Work that fails every test gets the `/wrist-slap-me` treatment: slap first, then the exits.

## Implementation Completeness (Beyond Local Oracles)

Passing a unit test or MRE oracle is necessary but not sufficient. Before opening a PR or marking a requirement complete, verify seven integration boundaries:

1. **Full-Lifecycle Propagation:** A new property or claim (e.g., `auth.tenantId`) is not done when it reads back from the setter. Trace and test its flow through operations (`signIn*`), resulting handles (`user.tenantId`), and downstream enforcement (Security Rules context).
2. **Algebraic & Short-Circuit Composition:** In rules evaluators, type or runtime failures must produce first-class error values (`RuleError`) that participate in CEL/Rules commutative error absorption (`error || true`, `error && false`), never raw host booleans or generic strings.
3. **Dual-Plane Parity (Sandbox + Worker Bridge):** Any SDK surface or return-shape change in `packages/pyric/src/` must also be checked against the CLI/Studio worker protocol in `packages/cli/src/serve/`.
4. **Foundation Reuse (`pyric/sandbox/internal`):** Never duplicate cross-service logic (auth normalization, path canonicalization, error shapes) inside a single service package. Reuse or extend the shared sandbox foundation.
5. **Cross-Runtime Fallback Verification:** In dual-runtime utilities (e.g., `typeof Buffer === 'function'` vs. browser `btoa`), `bun test` only hits the Node/Bun branch by default. Explicitly test the browser/worker branch by temporarily deleting the Node global (e.g., `delete (globalThis as any).Buffer`) and asserting parity across boundary cases (empty payloads, padding remainders).
6. **Conformance Registry Per-Service Count Invariant:** Every assurance node belongs to one service: a row in `packages/conformance/registry/<service>.ts`, or a construct in `packages/conformance/rules-language/<engine>.json` (service `<engine>-rules`). Each service commits its node count in `packages/conformance/assurance-node-counts/<service>.json`, and `packages/conformance/test/src/conformance-model.test.ts` fails when a service's derived count differs from that file, naming the service and the file. Adding or removing a row is a deliberate edit to that one service's count file in the same change; a new service adds its file and a removed service deletes its file. Run that test whenever registry rows or rules-language constructs change.
7. **Integration Evidence Through Real Entry Points:** A test that builds the payload, injects the frame, fakes the socket, mocks the timers, or passes a file in memory is unit evidence, however much real code it runs. A fix for a bug reported from a real app adds or extends an app scenario under `test/apps/` that installs the packed packages and drives the path the report took: the dev server, a `node --import @pyric/cli/register` process, Chromium, and the `pyric` command the user ran. Write it from the report, run it against `main` first, and record that failure in the commit body. A new feature reachable from a page, a server process, or the CLI gets the same scenario. When a bug's premise depends on runtime behavior (a browser lifecycle, a socket close, a restart), observe it in that runtime before fixing it; Playwright's defaults disable some of them, such as the back-forward cache. Every PR body names its integration test, or states why the change has no runtime path. A scenario that waits on real timeouts exports `slow = true` from its `scenario.ts`: pull requests skip it, and it runs on main, nightly, and on pull requests labeled `ci-slow-scenarios`. A PR that changes what a slow scenario covers gets that label and names the run.

