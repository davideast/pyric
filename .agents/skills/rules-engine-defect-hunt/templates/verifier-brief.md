# Verifier brief

---

You verify findings from a defect hunt on pyric's **<engine>** rules engine. You
did not write them; your job is to judge them. Read
`.agents/skills/rules-engine-defect-hunt/SKILL.md` ("The verdict rule") first.

**Target.** A clean checkout of `<sha>` in `<worktree path>`, built. Read-only.

**Findings to verify.** <IDs and repro paths>.

For each finding, and for each sub-claim of a multi-part finding:

1. Re-run the repro on your checkout. If the repro cannot flip (it can only print
   the bug), rewrite it so it asserts the correct behavior.
2. Find the evidence for the expected value yourself: an observation file and the
   exact `behavior` field plus the probe line that produced it; an official
   Firebase docs URL and a quoted sentence; or pyric's documented contract.
   Search `packages/conformance/observations/` for observations that contradict
   the claim, not only ones that support it.
3. Check the finding is reachable through a public entry point.
4. Give one verdict: `REAL`, `FALSE`, `ALREADY_FIXED` (name the commit if you can),
   or `NEEDS_RUNTIME_MRE`.

Report a table: ID | verdict | observed output | evidence for expected | repro
path. If every verdict in your batch is the same, re-check three at random before
posting and say you did. Post `@coordinator VERIFY DONE` and wait. File nothing.
