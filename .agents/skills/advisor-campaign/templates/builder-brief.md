# Builder brief

Copy, fill the angle brackets, and post as the slice builder's assignment.

---

Builder for **<slice title and issue/ADR reference>** in `<worktree-dir>`
(branch `<branch-name>`, from `origin/main` @ `<base-sha>`).

### Operating and file-ownership rules

- Read `AGENTS.md`, `PRIORITIES.md`, `docs/code-conventions.md`,
  `.github/pull_request_template.md`, and `.agents/skills/advisor-campaign/`
  (`SKILL.md` plus `references/implement.md`, `references/tdd.md`,
  `references/code-review.md`, and `references/hygiene.md`) first.
- Run `bun install --frozen-lockfile` and `bun run build` in `<worktree-dir>`.
- **Owned files (stay strictly within these so parallel slices never collide):**
  - `<owned path or glob 1>`
  - `<owned path or glob 2>`
- **Must not edit:** `<files owned by sibling slices or shared workflow/entry files>`.
  If you need a one-line export or shared adjustment outside your owned list,
  ask the coordinator before editing.
- **Commit locally ONLY -- do NOT push or open a pull request.** Perform a
  two-axis `Spec` + `Standards` self-review on `git diff <base-sha>` first,
  commit locally, and report the commit SHA and verification counts for
  independent parallel review.
- Strict plain ASCII (`<= 127`), `<= 600` lines per new or non-legacy file
  (legacy `> 600`-line files must not grow), `0` added `!` non-null assertions,
  `0` nested/multi-line/work-performing ternaries, `0` conditional object
  spreads, `0` Knip PR findings, synthetic domain nouns only, and zero private
  ops, hunt, or machine/session leakage.

### Public seams under test

- `<public entrypoint or module seam 1>` -- catches `<what it proves>`; `<runtime
  edge covered by test/apps/<scenario> or why none applies>`.
- `<public entrypoint or module seam 2>` -- catches `<what it proves>`.

### Concrete deliverables

1. **<Deliverable 1: behavioral invariant and contract>**
   - <Behavioral requirement, expected upstream Firebase parity, and concrete
     counterexamples to cover via vertical `RED -> GREEN` TDD slices.>
   - <Sibling planes to keep in sync: in-process sandbox, SharedWorker bridge in
     `packages/cli/src/serve/`, Node host, CLI/MCP surfaces.>
2. **<Deliverable 2: standing check / conformance / CI wiring>**
   - <Standing mechanical test, `test/apps/<scenario>` scenario, or conformance
     evidence / `Conformance-Exempt: <reason>` git trailer when engine paths move.>
3. **Verify locally before committing:**
   - `<targeted package builds and unit/integration test commands>`
   - Strict `tsc --noEmit` on touched packages and new/modified `test/**/*.test.ts`
   - `CI_BASE_SHA=<base-sha> CI_HEAD_SHA=HEAD bun scripts/ci/knip-audit.ts` (`0` PR findings)
   - `PR_BODY_FILE=/dev/null bun scripts/ci/deletion-guard.ts <base-sha> HEAD`
   - Plain ASCII (`<= 127`) and `<= 600` line count check across all changed files
     and the commit message.

Post the 40-char commit SHA and verification summary to `@coordinator` when done.
