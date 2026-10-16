# Hunter brief

Copy, fill the angle brackets, post as the worker's assignment.

---

You own the **<workstream>** workstream of a defect hunt on pyric's
**<engine>** rules engine. Read `.agents/skills/rules-engine-defect-hunt/SKILL.md`
and `references/workstreams.md` (section <n>) first.

**Target.** `origin/main` @ `<sha>`, checked out in your own worktree
`<worktree path>` and built (`bun install --frozen-lockfile && bun run build`).
Read-only on pyric source: no fixes, commits, or pushes. Do not deploy anything or
call a production endpoint.

**Surfaces in scope.** <files / entry points>.

**Referee for this workstream.** <production observations | documented contract |
sibling surface>. Existing observations: `packages/conformance/observations/<dirs>`.

**Deliverables.**

- One repro per finding at `<scratch dir>/<workstream>/<ID>.mjs`, importing the
  built package, asserting the correct behavior, printing `OPEN` or `FIXED` with
  the observed values.
- Post each finding to the board as: ID (`<PREFIX>-<n>`), one-line defect,
  severity (fail-open / false confidence / deploy failure / cosmetic), observed vs
  expected, the evidence for expected (observation field + probe line, docs quote,
  or contract line), repro path.
- Post clean results too: what you ran that found nothing, with counts.

**Rules.** Every expected value cites its source, or the finding is marked
`NEEDS_RUNTIME_MRE`. Check existing observations before claiming production
behavior. Do not edit tests or observations. When done, post `@coordinator
HUNT DONE <workstream>` with a summary table, then wait.
