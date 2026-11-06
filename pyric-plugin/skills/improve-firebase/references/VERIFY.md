# Verifying a change before and after

Use `verify <PR | branch | plan>` to check a claimed fix with evidence instead
of reading the diff. Build the app as it is before the change and after it,
run both in the local Pyric sandbox, and report what each build actually does.
The result is E2 evidence.

## Rules

- Never modify the user's checkouts. Build from temp copies.
- Never push, comment on, or edit the PR.
- Run only against the local sandbox, with synthetic identities and seed data.

## 1. Build before and after into temp dirs

Before is the base branch (usually `main`). After is the PR head, branch, or
the plan applied.

For a PR, make a temp copy and apply the change there:

```bash
git -C <repo> worktree add /tmp/<name>-after <base>
cd /tmp/<name>-after
gh pr diff <n> --repo <owner/repo> | git apply   # or: git checkout <branch>
ln -s <repo>/node_modules node_modules           # repeat for workspace packages that need it
```

Symlink `node_modules` instead of installing so the build matches the user's
dependencies and nothing is written to their lockfile. For a plan, apply its
ordered edits to the temp copy only.

For Vite with `@pyric/cli/vite`, build each side into its own temp dir:

```bash
SPACES_PYRIC=1 npx vite build --mode sandbox --outDir /tmp/<name>-before-dist
SPACES_PYRIC=1 npx vite build --mode sandbox --outDir /tmp/<name>-after-dist
```

The env flag and mode come from the project's Vite config; check it before
building. Other frameworks: use the project's build command with an output
directory in `/tmp`.

Copy the Rules the app deploys (strip comments if the file has them) and write
a small seed with synthetic users and the records the claim needs.

## 2. Run a fast state check first

Before writing a scenario, prove the sandbox can see the claim. Write a short
Node script (about 11 seconds per build) that:

1. Starts `IsolatedSandbox` from `scripts/lib/sandbox-client.mjs` with the
   build, Rules, and seed.
2. Signs in each actor with `signInActorPage` from `scripts/lib/identity.mjs`.
3. Reads the relevant state with `sandbox.readState(...)`.
4. Performs the action through the real UI.
5. Reads the state again, plus `sandbox.getDenials(...)`.

Run it against the before build, then the after build (`DIST=<dir>`). If the
before build doesn't show the defect, stop: there is nothing to record.

## 3. Report per claim

| Result | Meaning |
|---|---|
| Reproduced and fixed | The defect shows on before and is gone on after |
| Clean on old code | Before already behaves correctly, so the change isn't needed for this claim |
| Not observable in sandbox | The sandbox can't show it (see the known limits in [RECORD.md](RECORD.md)); needs the Firebase emulator |

Give the observed numbers, for example "entry still present 3 s after sign-out
on before; removed about 350 ms after sign-out on after".

## 4. Record when asked

When the user wants a video, turn the state check into a build-variant
scenario: `app.dist` is before and `behavior.fixApp.dist` is after. Follow
[RECORD.md](RECORD.md); its PR 372 example is this workflow end to end.
