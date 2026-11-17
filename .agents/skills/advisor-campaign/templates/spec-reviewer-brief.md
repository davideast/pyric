# Spec reviewer brief

Copy, fill the angle brackets, and post to a read-only reviewer that did not
author the slice.

---

Spec-axis reviewer for **<slice title> (`<branch-name>`, `<base-sha>...<head-sha>`)**
in `<worktree-dir>`.

### Rules (read-only reviewer)

- Read `.agents/skills/advisor-campaign/references/code-review.md` first.
- Do **NOT** edit, stage, commit, or leave untracked files in `<worktree-dir>`
  or the main checkout. Put any temporary probe scripts in `<external-scratch-dir>`
  and remove them before finishing.

### Assignment (Spec axis only)

1. Read the originating spec (`<issue / ADR / builder brief>`) and the builder's
   report, and inspect:
   - `git -C <worktree-dir> log <base-sha>..<head-sha> --stat`
   - `git -C <worktree-dir> diff <base-sha>...<head-sha>`
2. Audit thoroughly along the **Spec** axis:
   - **Clause-by-clause fidelity:** verify every requirement and edge case in the
     spec is implemented and covered at public seams, and check that nothing
     outside scope was added.
   - **Empirical checks against installed upstream Firebase SDKs and observations:**
     run read-only probes from `<external-scratch-dir>` against the installed
     `firebase` and `firebase-admin` packages in `<worktree-dir>/node_modules`
     (error codes, synchronous throws vs rejected promises, validation check
     ordering, boundary inputs) and compare against
     `packages/conformance/observations/`.
   - **Simulated follow-up states and cross-plane parity:**
     - <Simulate downstream states, e.g., what happens on an observations-only
       capture PR before `rowIds` are linked, after rebase/regeneration, or
       across in-process sandbox, SharedWorker, and Node host.>
     - Verify new regression or standing checks actually fail (`RED`) against
       `<base-sha>`'s production logic and pass (`GREEN`) at `<head-sha>`.
   - **Security and trust boundaries (when CI/host/bridge code changes):**
     trace untrusted inputs, credential boundaries, pagination truncation, and
     fail-closed behavior.

### Output

Report:
- `(a)` missing or partial spec requirements (citing spec clauses),
- `(b)` unrequested behavior or scope creep,
- `(c)` upstream-parity, follow-up state, or edge-case bugs (with reproduction
  output),
- final verdict for `<40-char-head-sha>`: **`MERGE`** or **`FIX`**.

Once a pull request is open for `<40-char-head-sha>`, post (or hand to the
coordinator to post) the SHA-pinned verdict comment:

```sh
bun scripts/ci/campaign-verdict.ts \
  --pr <pr-number> \
  --repo <owner/repo> \
  --axis spec \
  --verdict <MERGE|FIX> \
  --sha <40-char-head-sha> \
  --summary "<concise plain-ASCII summary>"
```

Marker format:
`<!-- campaign-verdict axis=spec verdict=MERGE|FIX sha=<40-char head sha> -->`
