# Two-axis code review: Spec and Standards

Review the diff between `HEAD` and a pinned base commit along two independent
axes:

- **Spec**: does the change implement every clause of the originating spec or
  issue accurately, match upstream Firebase behavior empirically, survive
  follow-up states, and avoid unrequested scope creep?
- **Standards**: does the change obey all documented repository rules, workflow
  security rules, hygiene rules, and the Fowler code-smell baseline?

When run by the coordinator after a builder commits locally, spawn **two parallel
read-only reviewers** (one per axis) so neither axis crowds out or anchors the
other. Builders also run both passes on `git diff <base-sha>` before committing.

## 1. Pin the fixed point

Capture the exact commit range up front:

```sh
git -C <worktree> rev-parse <base-sha> HEAD
git -C <worktree> log <base-sha>..HEAD --oneline
git -C <worktree> diff <base-sha>...HEAD
```

Confirm the diff is non-empty and touches only files the slice owns (plus any
coordinator-approved exceptions).

## 2. Spec axis checks

1. **Clause-by-clause fidelity**: map every requirement in the originating issue,
   ADR, observation, or builder brief to concrete code and tests. Flag missing or
   partial requirements (`(a)`) and unrequested behavior or scope creep (`(b)`).
2. **Empirical upstream SDK and observation checks**: never guess what production
   Firebase does. Run small read-only probes in an external scratch directory
   against the workspace's installed `firebase` and `firebase-admin` packages
   (check error codes, preflight check ordering, synchronous throws vs rejected
   promises, and edge inputs) and cross-check `packages/conformance/observations/`.
3. **Simulated follow-up states and cross-plane parity**: trace what happens on
   the next step of a multi-PR or multi-plane workflow (for example: an
   observation-only PR before source links `rowIds`; a rebase that regenerates
   scorecards; parity across in-process sandbox, SharedWorker, and Node host; and
   reverting the production fix to verify new tests fail RED).

## 3. Standards axis checks

Audit against `AGENTS.md`, `PRIORITIES.md`, `docs/code-conventions.md`,
`.github/pull_request_template.md`, and [hygiene.md](hygiene.md):

1. **Hygiene and plain ASCII**: `0` non-ASCII bytes (`<= 127`) in commits and
   changed files; synthetic nouns only; public imports in docs/PR samples; zero
   machine paths, session IDs, hunt IDs, model names, or private ops details.
2. **Structure and size (`docs/code-conventions.md`)**: every new or non-legacy
   file `<= 600` lines; legacy `> 600`-line files do not grow (`wc -l` at base vs
   head); one concept per file; surface-local backends (`<surface>/sandbox/`);
   pure re-export barrels (`index.ts` has zero implementation); `0` `.test.ts`
   files under `packages/*/src/`; `0` junk-drawer filenames (`utils`, `helpers`,
   `common`, `shared`, `misc`).
3. **Control flow and TypeScript discipline**: `0` added `!` non-null assertions;
   `0` nested, multi-line, or work-performing ternaries (`docs/code-conventions.md`
   section 3b); `0` conditional object spreads encoding feature presence (section
   3c); strict `tsc --noEmit` clean on both `src/` and `test/`.
4. **GitHub Actions security** (when `.github/workflows/` or `scripts/ci/`
   changes): minimal `permissions:` per job; untrusted `pull_request` /
   `issue_comment` workflows never check out or execute PR code (`ref: main`,
   `persist-credentials: false`); zero `${{ ... }}` interpolation inside `run:`
   blocks (pass untrusted values via `env:`); `workflow-paths.test.ts` green.
5. **Repository CI gates and app scenario list**: run `knip-audit.ts` (`0` PR
   findings), `deletion-guard.ts`, and compute the authoritative non-slow
   `test/apps/<scenario>` list via `scripts/ci/plan.ts` (`selectAppScenarios`)
   for the pull request body.

### Fowler code-smell baseline (_Refactoring_, ch. 3)

- **Repository rules win.** Where a documented repository convention endorses a
  shape the smell list would flag, suppress the smell.
- **Label judgement calls.** Distinguish hard standard violations (`(a)`) from
  baseline smell judgement calls (`(b)`).

Check for:

- **Mysterious Name**: identifier hides what it does or holds -> rename clearly.
- **Duplicated Code**: same logic shape repeated across hunks/files -> extract.
- **Feature Envy**: function reaches into another module's data more than its own
  -> move beside that data.
- **Data Clumps**: same parameter tuple travels together repeatedly -> group into
  a named interface.
- **Primitive Obsession**: raw string/boolean encodes a domain concept -> give it
  a narrow type or predicate.
- **Repeated Switches**: same `switch` or `if`-chain on one discriminant recurs
  -> consolidate into one table or dispatch function.
- **Shotgun Surgery**: one logical change scatters tiny edits across many files
  -> colocate what changes together.
- **Divergent Change**: one file changes for unrelated reasons -> split by reason
  to change.
- **Speculative Generality**: hooks, flags, or abstractions unused by the spec ->
  delete or inline.
- **Message Chains**: deep `a.b().c().d()` navigation -> hide behind one seam.
- **Middle Man**: wrapper that only forwards calls unchanged -> call target
  directly.
- **Refused Bequest**: implementer stubs out or ignores most of an interface ->
  narrow the interface or compose.

## 4. Aggregation and PR verdict markers

Keep `## Spec` and `## Standards` separate without merging or re-ranking findings
across axes. End with findings per axis, highest-risk item per axis, and overall
`MERGE` vs `FIX`.

Once the branch is pushed and the PR is open, record each axis's SHA-pinned
verdict on the PR using `scripts/ci/campaign-verdict.ts`:

```sh
bun scripts/ci/campaign-verdict.ts \
  --pr <pr-number> \
  --repo <owner/repo> \
  --axis spec \
  --verdict MERGE \
  --sha <40-char-head-sha> \
  --summary "All spec clauses and upstream SDK checks pass."
```

Each verdict comment ends with a standalone hidden marker line:

`<!-- campaign-verdict axis=spec|standards verdict=MERGE|FIX sha=<40-char head sha> -->`
