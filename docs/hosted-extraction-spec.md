# Extraction specification: foundation slice

Written 2026-09-19. This is the specification for the first pull request from the hosted work. It is the mechanical step described in `docs/hosted-release-plan.md` section 2. The implementing agent performs it; the reviewer verifies it the same way as a ledger item.

## What the slice is

Everything the branch changed under `packages/pyric` and `packages/pyric-admin`, applied as one commit onto a branch cut from `main`, plus the phase 1 acceptance tests, the runner, and a map restricted to what exists on the slice.

Source of truth: `origin/hosted-main-integration` at `5538e1d2`. Base: `origin/main` at `f7e90081`.

Why this boundary: `packages/pyric` imports nothing from `packages/cli`; the three mentions of the cli package in its source are comments. `packages/pyric-admin` changed only to follow a `pyric/messaging` export change and must travel with it. Everything else on the branch depends on these two packages, and nothing in them depends on anything else.

What is not in this slice: `packages/cli`, `packages/studio`, `packages/ui`, `packages/site-docs`, `examples`, `scripts` other than the ledger runner, and every document under `docs/` except the four handoff documents named below. The A5 fix (browser entries, worker client transports) and the A7 fix (hosted persistence admission, worker inbound validation) live under `packages/cli` and land with the transport and host slices. Their acceptance tests stay on `hosted-main-integration` until then.

## Steps

Run every command from the repository root on a clean tree. Do not use `git stash`.

1. Cut the branch.

   ```
   git fetch origin main hosted-main-integration
   git checkout -b slice/foundation origin/main
   ```

2. Apply the package diff as one commit. Use the three-dot diff so the comparison is against the merge base.

   ```
   git diff origin/main...origin/hosted-main-integration -- packages/pyric packages/pyric-admin | git apply --index
   git commit -m "feat(sandbox): hosted foundation for pyric and pyric-admin"
   ```

   The commit body lists, one line each, the ledger items whose fixes are included: A1, A2, A3, A4, A6, I1, I13, and the A11, A12, A13 follow-ups as still open. If `git apply` reports a conflict, stop and report the file; do not resolve by hand.

3. Add the handoff documents and the runner as a second commit.

   ```
   git checkout origin/hosted-main-integration -- docs/hosted-release-plan.md docs/hosted-review-ledger.md docs/hosted-agent-brief.md docs/hosted-persistence-plan-review.md docs/hosted-extraction-spec.md scripts/verify-ledger.ts scripts/ledger-acceptance.json
   ```

   Then edit `scripts/ledger-acceptance.json` on this branch to keep only entries whose test files exist on this branch: A1, A2, A3, A4, A6, I1, I13-omitted. Remove A5 and A7. Commit as `docs(hosted): review ledger, plan, and acceptance runner`.

4. Prove the slice stands alone. Every command must be green with no test changed.

   ```
   bun install --frozen-lockfile
   bun run --cwd packages/pyric build
   bun run --cwd packages/pyric typecheck
   bun run --cwd packages/pyric-admin typecheck
   bun scripts/verify-ledger.ts --phase 1
   bun test packages/pyric
   bun test packages/pyric-admin
   bun test packages/conformance
   ```

   The three live Rules API files under `packages/pyric/test/rules/parity` need network access. If the environment has none, list them as not run; do not skip them in code.

   `packages/conformance` is included because AGENTS.md boundary 6 pins the registry's total count. If the count test fails, stop and report; the slice does not change registry rows, so a failure there means the diff pulled in something it should not have.

5. Prove the rest of the repository still builds against the slice. The cli on `main` compiles against the slice's pyric.

   ```
   bun run --cwd packages/cli typecheck
   bun test packages/cli/test/serve/worker
   ```

   These exercise main's worker against the slice's shared shapes. A failure here is a dual-plane parity break (AGENTS.md boundary 3) and is reported, not patched on this branch.

6. Submit in the standard block. The `After` line is the `verify-ledger --phase 1` output on the tip. `Suites` lists every command in steps 4 and 5 with counts. `Files` is the `git diff --stat origin/main` summary.

## What the reviewer checks

- The first commit's diff equals `git diff origin/main...origin/hosted-main-integration -- packages/pyric packages/pyric-admin` byte for byte.
- The second commit touches only the seven named files.
- Every command in steps 4 and 5 reproduces on the reviewer's checkout.
- No file outside the two packages, the four documents, and the two scripts is present.

## After verification

The reviewer records the branch and result in the plan's tracking table. The owner opens or approves the pull request; no agent opens or merges it. The transport slice is specified after this pull request is approved, and it cuts from this branch rather than from `main` so it inherits the foundation.
