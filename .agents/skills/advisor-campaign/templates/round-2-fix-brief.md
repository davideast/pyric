# Round-2 fix brief

Copy, fill the angle brackets with cited findings from both review axes, and
send back to the slice builder while keeping the branch local.

---

Parallel two-axis review on `<round-1-sha>` (`<branch-name>`) is complete:
- **Spec:** `<MERGE|FIX>` -- `<one-line summary of Spec findings>`
- **Standards:** `<MERGE|FIX>` -- `<one-line summary of Standards findings + authoritative test/apps/<scenario> list>`

Implement Round 2 cleanly in `<worktree-dir>` (**commit locally only -- do NOT
push or open a pull request yet**), staying within your owned files:

1. **Resolve Spec findings (`<cite Spec items, e.g. section a.1, section c.1>`):**
   - <State the behavioral invariant, upstream Firebase answer, concrete
     counterexample, and simulated follow-up state that must hold -- without
     dictating private helper names.>
   - <Add or tighten behavioral tests at the agreed public seam and confirm they
     fail against the pre-fix state.>
2. **Resolve Standards hard violations and accepted cleanups (`<cite Standards items, e.g. section a.1, section b.1>`):**
   - <Cite exact file, line, and `docs/code-conventions.md` / `AGENTS.md` /
     `references/hygiene.md` rule to fix.>
3. **Re-verify end-to-end:**
   - Re-run `<affected package builds, unit/integration suites, and simulated follow-up checks>`.
   - Re-run strict `tsc --noEmit` (including modified test files),
     `CI_BASE_SHA=<base-sha> CI_HEAD_SHA=HEAD bun scripts/ci/knip-audit.ts` (`0` PR findings),
     and `PR_BODY_FILE=/dev/null bun scripts/ci/deletion-guard.ts <base-sha> HEAD`.
   - Confirm `0` non-ASCII bytes (`<= 127`) across all changed files and commit
     messages, and every new/non-legacy file `<= 600` lines (zero growth on any
     legacy `> 600`-line file).

Commit locally on `<branch-name>` and post the updated 40-char commit SHA plus
verification counts to `@coordinator` for Round 2 verification.
