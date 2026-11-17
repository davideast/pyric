# Pull request body checklist and push sequence

Use this checklist only **after** independent `Spec` and `Standards` reviews
both return `MERGE` on the slice's local commit.

## 1. Rebase, push, and open sequence

1. **Rebase onto latest `origin/main` before pushing** whenever sibling PRs
   have landed on `main` (`git fetch origin main && git rebase origin/main`),
   then re-run affected gates so cross-PR semantic interactions are caught
   locally before `merge-queue/staging`.
   - Prefer rebasing *before* final two-axis review whenever overlapping files
     or shared baselines moved.
   - Because rebasing rewrites the commit SHA (`<reviewed-sha>` ->
     `<rebased-sha>`), if you rebase mechanically *after* review, confirm zero
     conflicts, an empty `git range-diff <old-base>..<reviewed-sha> origin/main..<rebased-sha>`,
     and green post-rebase gates, then post verdicts for `<rebased-sha>`. If any
     conflict was resolved, any baseline/projection was regenerated, or any hunk
     changed, run an incremental `Spec` + `Standards` re-check on `<rebased-sha>`
     before pushing.
2. Push the branch: `git push -u origin <branch-name>`.
3. Open the pull request against `main` **without** manually adding the
   `merge-queue` label (`gh pr create --repo <owner/repo> --base main --head <branch-name> --title "<title>" --body-file <body-file>`).
   When updating an existing PR body later, use REST
   (`gh api -X PATCH 'repos/{owner}/{repo}/pulls/<pr>' -F body=@<body-file>`),
   because `gh pr edit` is broken on this repository.
4. Verify `0` non-ASCII bytes (`<= 127`) in the live title and body:
   ```sh
   gh pr view <pr-number> --repo <owner/repo> --json title,body \
     | LC_ALL=C grep -v '^[ -~	]*$' && exit 1 || true
   ```
5. Post both SHA-pinned `MERGE` verdicts for the PR's pushed 40-char `HEAD` SHA
   using an `OWNER`, `MEMBER`, or `COLLABORATOR` user token (never
   `GITHUB_TOKEN` or a bot token, which `campaign-verdicts.ts` ignores):
   ```sh
   bun scripts/ci/campaign-verdict.ts \
     --pr <pr-number> --repo <owner/repo> \
     --axis spec --verdict MERGE --sha <40-char-pr-head-sha> \
     --summary "<plain-ASCII Spec summary>"

   bun scripts/ci/campaign-verdict.ts \
     --pr <pr-number> --repo <owner/repo> \
     --axis standards --verdict MERGE --sha <40-char-pr-head-sha> \
     --summary "<plain-ASCII Standards summary>"
   ```
   `.github/workflows/campaign-verdicts.yml` validates both trusted non-bot
   SHA-pinned `MERGE` markers, adds `merge-queue`, and dispatches
   `merge-queue.yml --ref main -f dry_run=false` (which waits for `CI / required`
   before staging and landing).

## 2. Pull request body skeleton

Delete HTML guidance comments before posting (`.github/pull_request_template.md`).

````markdown
<One to three plain-ASCII sentences naming what this PR adds or changes and why.>

```ts
// Self-contained runnable consumer example using ONLY public package entrypoints
// (pyric/*, pyric-admin/*, @pyric/*) or CLI/workflow commands -- never packages/*/src/*.
```

## Risk

<Concrete behavioral, compatibility, or security risks that need reviewer judgment near the top.>

## <Fact-stating heading specific to this change>

<Concise explanation after the code or table; 1 to 3 narrative headings total.>

<details>
<summary>Implementation notes</summary>

- Verification: `<commands and pass counts>`
- App scenarios (`AGENTS.md` boundary 7):
  - `test/apps/<scenario-1>`
  - `test/apps/<scenario-2>`
  <!-- Or state plainly why no runtime package path changed so no test/apps/<name> scenario applies. -->
  <!-- If tests or CI jobs were intentionally removed, include on its own line: Removes tests: <reason> -->

</details>
````

## 3. Pre-post gate checklist

- [ ] **Plain ASCII (`<= 127`)** in title, body, and commit messages (no em
      dashes, curly quotes, Unicode arrows, or emoji).
- [ ] **Public entrypoints only** in every code block (`pyric/*`, `pyric-admin/*`,
      `@pyric/*`, CLI/workflow commands -- zero `packages/*/src/*` imports).
- [ ] **`## Risk` near the top**, naming concrete edge cases or behavior shifts.
- [ ] **Fact-stating `##` headings** specific to this change (not `## Bug fix`
      or `## Changes`).
- [ ] **Authoritative non-slow `test/apps/<scenario>` list** (from the Standards
      review / `scripts/ci/plan.ts`) inside `<details>`, or an explicit note
      explaining why the diff has no runtime path. Remember: `plan.ts` reads the
      PR body as it stood when the run started; push or re-trigger if edited.
- [ ] **Zero leakage** (`references/hygiene.md`): synthetic domain nouns only;
      zero machine paths, session UUIDs, internal shortlinks, hunt IDs, model
      names, or private ops details.
