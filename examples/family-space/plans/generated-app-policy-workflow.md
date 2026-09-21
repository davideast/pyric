# Generated app policy workflow

Stage 1 established pinned-policy generation. The authored-policy extension below supersedes its original scope limits.

Acceptance gates:
- All new generation jobs discover policy capabilities before writing React.
- Agent tools reuse browser can-i-use and stdlib catalogs; curated guidance loads on demand.
- The agent may choose the exact chore-quest-v1 contract, or explicitly retain family-trust behavior. Unsupported permission requirements stop the build, never silently downgrade it.
- Preparing resolves modular source and rejects altered policies. Testing uses public evaluator and isolated sandbox operations; successful source and policy are saved together with evidence.
- Existing policy-enabled apps preserve their policy during regeneration. Interrupted jobs revalidate policy checkpoints; legacy jobs continue unchanged.
- UI activity shows assumptions, tool calls/results, and validation outcomes.
- Existing preview, identity, and atomic activation checks continue to apply.

Agreed test seams: generation workflow inputs/outputs, public policy-tool calls backed by pyric/rules and sandbox SDK operations, and browser generation/version interactions. Use deterministic model responses at the external model boundary, not mocked policy internals.

Original stage 2 target (now implemented within the documented capability boundary): arbitrary modular policies with a reusable AST compatibility validator, broader host-owned invariant suites and dependency resolution. Do not weaken the current allowlist to enable this prematurely.

## Stage 1 verification

Implemented on 2026-09-16. Results:
- 29 local tests pass; typecheck and production build pass.
- Browser: generated policy candidate, regeneration before activation, activation, and reload pass.
- Browser: existing app lifecycle, deletion/restoration, failed-build retry pass.
- Browser: parent/kid identity controls, direct bridge denials, completion/undo, reload and sign-out pass.
- Live configured provider with synthetic context: discovery, pinned preparation, all 28 standalone/sandbox cases, and React compilation pass. This checks model/tool plumbing, not universal correctness of generated React.
- Review found and fixed stale drafts emitted before resumed validation, candidate policy loss on regeneration, discovery bypass, malformed response handling, and duplicated prompt contract descriptions.

No deployment or cloud configuration changes. The Kin app and workspace dependency registration are included in a local commit at the user’s request. Unrelated package changes remain outside that commit.


## Authored policy extension

Format-2 artifacts now carry modular source, resolved rules, a permission summary
and bounded agent-authored cases. The host owns fixtures, outsider/signed-out
mutations, evaluator/sandbox parity, source integrity and AST scope/dependency
validation. Generation can finish in authored mode only after validation.
Runtime membership dependencies are resolved inside the write transaction;
source and policy still activate together. See README for supported boundaries
and the conservative existing-record compatibility check.
