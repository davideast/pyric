# Test-Driven Development

TDD is the `RED -> GREEN` loop. Consult these rules before and during every slice
so each cycle produces behavioral tests that survive internal refactors.

Read `AGENTS.md`, `PRIORITIES.md`, `docs/code-conventions.md`, and local ADRs in
`docs/decisions/` so test descriptions and assertions match the repository's
domain vocabulary.

## What a good test is

Tests verify observable behavior through public interfaces, not internal
collaborators or private state. Code structure can change completely while
behavioral tests stay green. A test description should read like a specification
clause ("rejects array-valued operand when nested deeper than one level") rather
than an implementation step.

See [tdd-tests.md](tdd-tests.md) for concrete good vs bad patterns and
[tdd-mocking.md](tdd-mocking.md) for boundary-only mocking rules.

## Seams: where tests go

A **seam** is the public boundary where callers observe behavior without reaching
into module internals: published package subpaths (`pyric/*`, `pyric-admin/*`,
`@pyric/*`), CLI commands, worker protocol boundaries, or pure CI decision
entrypoints.

**Test only at pre-agreed seams.** Confirm the seams under test from the builder
brief (or with the coordinator before writing tests). Never add unit tests coupled
to unconfirmed private helpers. For each seam, note in one line what defect class
it catches and what runtime boundary still requires an integration scenario under
`test/apps/`.

Mirror source paths under `test/`, one `.test.ts` file per source concept
(`docs/code-conventions.md` section 3). Never place `.test.ts` files inside
`packages/*/src/`.

## Anti-patterns

- **Implementation-coupled**: mocks internal modules, calls private helpers, or
  inspects internal fields instead of reading back through the public API. Tell:
  extracting a collaborator breaks the test when observable behavior is unchanged.
- **Tautological**: computes the expected value using the same formula or helper
  as production code (`expect(fn(x)).toBe(computeSameWay(x))`), so it passes by
  construction. Expected values must come from an independent oracle: a literal
  worked example, a committed production observation in
  `packages/conformance/observations/`, an installed upstream Firebase SDK check,
  or an explicit contract clause.
- **Horizontal slicing**: writing every test up front or applying an entire
  multi-file change before running a single failing assertion. Work in **vertical
  slices** instead: one failing test -> confirm RED -> minimal production code ->
  confirm GREEN -> next tracer bullet.

## Rules of the loop

- **Red before green.** Write the failing test first, run that single test file to
  witness the expected failure (or run a reproduction against `origin/main` first
  for bug fixes), and write only enough code to pass it.
- **One slice at a time.** One seam, one behavioral case, one minimal change per
  iteration.
- **Refactor during review.** Structural cleanups belong to the post-green
  self-review pass ([code-review.md](code-review.md)), with the suite kept green
  after every move.
