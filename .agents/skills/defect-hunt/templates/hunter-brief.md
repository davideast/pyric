# Hunter brief

Copy, fill the angle brackets, post as the worker's assignment.

---

You hunt the **<angle>** angle of a defect hunt on pyric's **<surface>**.
Read `.agents/skills/defect-hunt/SKILL.md` and
`references/workstreams.md` (section <n>) first<, and
`.agents/skills/<domain skill>/SKILL.md` for the surface map>.

**Target.** `origin/main` @ `<sha>`, checked out in your own worktree
`<worktree path>` and built (`bun install --frozen-lockfile && bun run build`).
Read-only on pyric source: no fixes, commits, or pushes. Do not deploy
anything, run a capture, or call a production endpoint; ask the coordinator for
a capture instead.

**Surfaces in scope.** <files / entry points>.

**Referee.** <production observations | contract (ADR and clause ids) | planes
that must agree>. Existing evidence: <`packages/conformance/observations/<dirs>`,
ADR path, differential fixtures>.

**Deliverables.**

- One repro per finding at `<scratch dir>/<angle>/<ID>.mjs`, importing the
  built package, asserting the correct behavior, printing `OPEN` or `FIXED`
  with the observed values.
- Post each finding to the board as: ID (`<PREFIX>-<n>`), one-line defect,
  severity (1 fail-open or data exposed, 2 false confidence, 3 deploy or
  load-time disagreement, 4 cosmetic), observed vs expected, the evidence for
  expected (observation field and probe line, docs quote, or contract clause),
  repro path.
- Post clean results too: what you ran that found nothing, with counts.

**Rules.** Every expected value cites its source, or the finding is marked
`NEEDS_RUNTIME`. Check existing observations and open issues before claiming a
finding is new. Do not edit tests or observations. When done, post
`@coordinator HUNT DONE <angle>` with a summary table, then wait.
