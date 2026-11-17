# Standards reviewer brief

Copy, fill the angle brackets, and post to a read-only reviewer that did not
author the slice.

---

Standards-axis reviewer for **<slice title> (`<branch-name>`, `<base-sha>...<head-sha>`)**
in `<worktree-dir>`.

### Rules (read-only reviewer)

- Read `AGENTS.md`, `PRIORITIES.md`, `docs/code-conventions.md`,
  `.github/pull_request_template.md`,
  `.agents/skills/advisor-campaign/references/code-review.md`, and
  `.agents/skills/advisor-campaign/references/hygiene.md` first.
- Do **NOT** edit, stage, commit, or leave untracked files in `<worktree-dir>`
  or the main checkout.

### Assignment (Standards axis only)

Inspect `git -C <worktree-dir> diff <base-sha>...<head-sha>` and commit messages
in `<base-sha>..<head-sha>`:

1. **Plain ASCII and zero leakage (`references/hygiene.md`, `AGENTS.md`):**
   - Verify `0` non-ASCII bytes (`<= 127`) across commit messages and all
     changed or added files.
   - Verify `0` hunt IDs, `0` machine or personal paths, `0` session UUIDs, `0`
     internal shortlinks, `0` agent/model/vendor names, `0` private ops details
     (cloud projects, service accounts, spend, or private repo names), and
     synthetic domain nouns + public package imports in docs/samples.
   - Verify Slice file ownership matches the builder brief.
2. **GitHub Actions security and conventions (when `.github/workflows/` changes):**
   - Verify zero `${{ ... }}` inline interpolation inside `run:` blocks (all
     event/input values passed via `env:`).
   - Verify least-privilege `permissions:` per job, `ref: main` +
     `persist-credentials: false` when untrusted PR events trigger without
     needing PR code, action version parity (`actions/checkout@v4`,
     `oven-sh/setup-bun@v2`), and `bun test scripts/ci/workflow-paths.test.ts`.
3. **`docs/code-conventions.md` and CI gates:**
   - Check file sizes: every new or non-legacy file `<= 600` lines, and confirm
     no legacy `> 600`-line file grew (`wc -l` at `<base-sha>` vs `<head-sha>`).
   - Check test placement (`0` `.test.ts` under `packages/*/src/`), barrel purity
     (`index.ts` re-exports only), `0` junk-drawer filenames, `0` added `!`
     non-null assertions, `0` nested/multi-line/work-performing ternaries
     (section 3b), and `0` conditional object spreads (section 3c).
   - Run `CI_BASE_SHA=<base-sha> CI_HEAD_SHA=<head-sha> bun scripts/ci/knip-audit.ts`,
     `PR_BODY_FILE=/dev/null bun scripts/ci/deletion-guard.ts <base-sha> <head-sha>`,
     strict `tsc --noEmit` (including modified tests), and affected CI test suites.
4. **Fowler code smells and `test/apps/<scenario>` selection:**
   - Check the 12-item Fowler smell list in `references/code-review.md`
     (distinguishing hard violations from judgement calls; repo rules override).
   - Compute the authoritative non-slow `test/apps/<scenario>` list via
     `scripts/ci/plan.ts` (`selectAppScenarios`) for the PR body (or confirm no
     runtime package paths changed).

### Output

Report:
- `(a)` hard standard violations (citing file, line, and rule),
- `(b)` Fowler code-smell judgement calls,
- authoritative non-slow `test/apps/<scenario>` list for the PR body,
- final verdict for `<40-char-head-sha>`: **`MERGE`** or **`FIX`**.

Once a pull request is open for `<40-char-head-sha>`, post (or hand to the
coordinator to post) the SHA-pinned verdict comment:

```sh
bun scripts/ci/campaign-verdict.ts \
  --pr <pr-number> \
  --repo <owner/repo> \
  --axis standards \
  --verdict <MERGE|FIX> \
  --sha <40-char-head-sha> \
  --summary "<concise plain-ASCII summary>"
```

Marker format:
`<!-- campaign-verdict axis=standards verdict=MERGE|FIX sha=<40-char head sha> -->`
