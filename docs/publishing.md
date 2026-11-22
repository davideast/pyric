# How to publish Pyric to npm

This guide publishes `@pyric/rules` (on its independent `0.x` version line) and
the six lockstep Pyric packages (`pyric`, `pyric-admin`, `create-pyric`,
`@pyric/cli`, `@pyric/ui`, and `@pyric/live`) from reviewed, merged commits on
`main`. Use the repository scripts for every version bump, verification, pack,
and publish operation. Do not edit package versions or run `npm publish`
directly.

Run every command from the repository root.

## Release ordering: `@pyric/rules` first, then lockstep `pyric`

`@pyric/rules` versions independently (`rules-v<version>` tags) while the six
Pyric packages version in lockstep (`v<version>` tags). When `pyric` is packed,
its `"@pyric/rules": "workspace:*"` dependency is rewritten to the exact version
in `packages/rules/package.json`.

`scripts/lib/check-publish-version.mjs` enforces two rules whenever you prepare
or publish the six lockstep packages:

1. The exact `@pyric/rules@<version>` named in `packages/rules/package.json`
   must already exist on npm.
2. Every shipped file in `packages/rules` (`package.json`, `README.md`,
   `LICENSE`, `src/**`, and packed `dist/**`) must match the immutable tarball
   published on npm for that version.

Because npm versions are immutable, any change to shipped files in
`packages/rules` requires publishing a new `@pyric/rules` version **before**
preparing or publishing the six lockstep Pyric packages.

## Channels (`PYRIC_PUBLISH_TAG`) and first-upload `latest`

`scripts/publish-alpha.sh` reads `PYRIC_PUBLISH_TAG` (default `latest`) to
choose the npm dist-tag:

- `latest` (default): for the six lockstep packages, publishes and points both
  `latest` and `alpha` at the new version, then runs `bun run compat:check` and
  moves `fb<major>.<minor>` on `pyric`, `pyric-admin`, `@pyric/cli`, and
  `@pyric/ui` when green. For `--package rules`, publishes `@pyric/rules` under
  `latest` (no `alpha` or `fb*` tag).
- `next`: for the six lockstep packages, moves only `next` (plus the `fb*`
  compatibility tag when `compat:check` is green), leaving `latest` and `alpha`
  untouched. For `--package rules`, moves only `next`.
- Any other tag, such as `PYRIC_PUBLISH_TAG=exp`: moves only that tag (`exp`)
  and skips `compat:check` so no `fb*` compatibility certificate is issued.

**Brand-new packages always receive `latest` on first upload:** npm requires
every package on the registry to have a `latest` dist-tag. On the very first
upload of a package that does not exist on npm yet (such as the initial publish
of `@pyric/rules` or `@pyric/live`), npm automatically assigns `latest` to that
version in addition to whatever `--tag` (`PYRIC_PUBLISH_TAG`) was passed. On all
subsequent uploads of an existing package, `PYRIC_PUBLISH_TAG=exp` moves only
`exp`.

Note that the repository scripts publish newly built tarballs; there is no
repository script that promotes an already-published version from `exp` to
`latest`.

## Before you start

You need:

- push and pull-request access to `davideast/pyric`;
- publish access to `@pyric/rules` (for `--package rules`) and to `pyric`,
  `pyric-admin`, `create-pyric`, `@pyric/cli`, `@pyric/ui`, and `@pyric/live`
  (for lockstep Pyric releases);
- an npm granular access token configured in your user-level `~/.npmrc` with
  read/write access to the packages being published and bypass 2FA enabled. The
  first release that creates `@pyric/rules` or `@pyric/live` on npm cannot use a
  token limited only to already-existing packages: give the token read/write
  access to the `@pyric` scope (or to all packages) for that release, and pass
  `PYRIC_PUBLISH_SCOPE_WRITE=@pyric` on the command line for both the preflight
  and the publish (see
  [Publish access is checked first](#publish-access-is-checked-first));
- `bun`, `node`, `npm`, `git`, and an authenticated GitHub CLI (`gh`); and
- a clean working tree with all release changes already merged to `main`.

Confirm the credentials before cutting the release:

```bash
gh auth status
npm whoami --registry=https://registry.npmjs.org/
stat -c '%a %U %n' "$HOME/.npmrc"
```

The npm config should be owned by your user and have mode `600`. Never copy it
into the repository or paste its token into a command.

### Publish access is checked first

npm uploads cannot be taken back, so the preflight and the publish both start
by checking that the account can publish every package in the release, before
any gate runs. `scripts/lib/check-publish-access.mjs` makes read-only
requests:

```bash
npm whoami                                       # the account
npm access list packages <account> --json        # {"pyric": "read-write", ...}
npm view <package> name                          # E404: not on the registry yet
npm access list collaborators <package> --json   # {"<account>": "read-write", ...}
```

The collaborator list is the fallback: when the account listing fails, or
leaves out a package the registry already has, that package passes only if
the account is a `read-write` collaborator on it. The check refuses, naming
each package, when a package is listed `read-only`, when the account is not a
`read-write` collaborator, when both lists fail, or when the registry lookup
fails for a reason other than a 404.

A package not on the registry yet has no permission to list: the release
creates it, which takes a token with read-write access to its scope (or to all
packages, for an unscoped name). No read-only request can prove a token has
that, so the check refuses unless you state it:

```bash
# First publish of @pyric/rules:
PYRIC_PUBLISH_SCOPE_WRITE=@pyric bun run release:preflight --package rules "$RULES_VERSION"
PYRIC_PUBLISH_SCOPE_WRITE=@pyric bash scripts/publish-alpha.sh --package rules "$RULES_VERSION"

# First lockstep release that creates a new @pyric/* package (such as @pyric/live):
PYRIC_PUBLISH_SCOPE_WRITE=@pyric bun run release:preflight "$RELEASE_VERSION"
PYRIC_PUBLISH_SCOPE_WRITE=@pyric bash scripts/publish-alpha.sh "$RELEASE_VERSION"
```

Set it only after you have given the token read-write access to the whole
`@pyric` scope. It covers only packages not on the registry yet; it never
lets through an existing package the account cannot write.

Set it on the command, as above, and never in `.env`: `bun run` loads `.env`,
so a value left there would acknowledge every new package of every later
release without anyone checking the token.

The listing reports the account's access. Whether npm narrows it to a
granular token's package selection is not documented, so a token limited to
fewer packages than the account owns can still pass for existing packages.
Give the token every package in the release.

This token flow is a short-term bridge, not the permanent release design. npm
expects bypass-2FA granular access tokens to lose direct-publish capability
around January 2027. Before that cutoff, migrate this repository to npm trusted
publishing (OIDC) or staged publishing with human approval. Do not respond to
the deprecation by making the token broader or longer-lived. The earlier August
2026 restriction affects account, package, and organisation management; use an
interactive 2FA session for those operations. See [npm install-time security
and GAT bypass2fa deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/).

---

## Releasing `@pyric/rules` (`--package rules`)

Choose the `@pyric/rules` version:

```bash
RULES_VERSION=0.1.0
```

### R1. Prepare the `@pyric/rules` release pull request (when bumping the version)

If `packages/rules/package.json` and `packages/rules/CHANGELOG.md` on `main` are
already at `$RULES_VERSION` (as for the initial `0.1.0` release), skip directly
to **R2**.

For every subsequent rules version bump (`0.1.1`, `0.2.0`, etc.), update
`packages/rules/CHANGELOG.md` on `main` (or in the release branch) and run:

```bash
git status --short                    # must print nothing
bash scripts/prepare-release.sh --package rules "$RULES_VERSION"
```

This creates `release/rules-v<version>` from `origin/main`, updates only
`packages/rules/package.json`, refreshes `bun.lock`, runs
`check-publish-version.mjs --package rules`, commits
`release: rules-v<version>`, pushes the branch, and opens a pull request with
the `ci-packaging` label. Review and merge the pull request once all required
CI checks are green.

### R2. Check out `main` and rehearse `--package rules`

```bash
git switch main
git pull --ff-only origin main
git status --short                    # must print nothing
node scripts/lib/check-publish-version.mjs --package rules "$RULES_VERSION" "$PWD"

# Include PYRIC_PUBLISH_SCOPE_WRITE=@pyric only if @pyric/rules is not on npm yet:
bun run release:preflight --package rules "$RULES_VERSION"
```

The `--package rules` preflight:

1. checks read-only npm publish access for `@pyric/rules`;
2. builds workspace packages and runs every command in `RULES_ONLY_PROOF`
   (`packages/rules` typecheck, build, and tests; `compat:rules-score`;
   `packages/conformance` tests; and the external rules-data reader tests);
3. packs `@pyric/rules` alone (`dist/packages/pyric-rules-<version>.tgz`) and
   records its hash and tree state in `manifest.json`;
4. runs the rules tarball gate (`publint`, `attw --profile esm-only`,
   `check-exports`, `check-declaration-deps`, fresh empty-directory `npm install`,
   Node import and Firestore/Storage/RTDB evaluation, and `Bun.build` browser
   bundles verifying zero `node:` imports outside `@pyric/rules/internal/node`);
5. runs the `test/apps/rules-standalone` scenario against that same packed
   tarball and writes `dist/packages/proven.json`; and
6. copies the proven tarball to a temporary upload directory, verifies the copy
   against `proven.json`, checks `npm whoami`, and runs
   `npm publish --dry-run`.

### R3. Publish `@pyric/rules` and tag `rules-v<version>`

```bash
git status --short                    # must print nothing
# Include PYRIC_PUBLISH_SCOPE_WRITE=@pyric only if @pyric/rules is not on npm yet:
bash scripts/publish-alpha.sh --package rules "$RULES_VERSION"

npm view "@pyric/rules@${RULES_VERSION}" version
npm dist-tag ls @pyric/rules

git tag "rules-v${RULES_VERSION}"
git push origin "rules-v${RULES_VERSION}"
```

---

## Releasing the six lockstep Pyric packages

Confirm `@pyric/rules` at the version in `packages/rules/package.json` is
already published on npm and matches the workspace tree, then set the lockstep
release version:

```bash
RELEASE_VERSION=0.1.0-alpha.36
```

## 1. Prepare the release pull request

Start from a clean checkout. The preparation script fetches `origin/main`,
creates `release/v<version>` from that exact commit, bumps all six lockstep
package manifests, refreshes `bun.lock`, verifies the resulting versions and the
pinned `@pyric/rules` tarball on npm, commits the change, pushes the branch, and
opens the release pull request with its changelog.

```bash
git status --short                    # must print nothing
bash scripts/prepare-release.sh "$RELEASE_VERSION"
```

Review the pull request and verify that all required CI release gates are green before merging:
- **`packaging`**: packs tarballs and verifies installation, runtime asset paths, and subpath exports in a clean consumer;
- **`install-matrix`**: proves real tarball resolution across package managers (`npm`, `pnpm`, and `bun`);
- **`standalone`**: verifies standalone binary compilation and vendor smoke;
- **`release-contract`**: verifies safety contracts in release scripts (`scripts/publish-alpha.test.ts`);
- **Full test suite**: package build, sharded CLI test suite, library/UI tests, and conformance gates.

The `ci-packaging` label is automatically applied by `scripts/prepare-release.sh` to trigger these packaging and release gates on the release pull request. Pushes to `main` also unconditionally run the packaging gate. All required checks must be green on the exact release commit before publishing.

Merge the pull request; do not publish from the release branch.

If the script refuses a dirty working tree, preserve or finish that work before
trying again. Do not bypass the cleanliness check.

## 2. Check out the merged release commit

Return to `main`, update it without creating a merge commit, and verify that the
six lockstep package manifests contain the requested version and `packages/rules`
matches its published npm tarball:

```bash
git switch main
git pull --ff-only origin main
git status --short                    # must print nothing
node scripts/lib/check-publish-version.mjs "$RELEASE_VERSION" "$PWD"
```

The version checker is the same guard used by the publish script. A mismatch or
an unpublished edit to `packages/rules` stops the release before building or
contacting the npm publishing endpoints.

## 3. Rehearse the complete release without publishing

Run the non-publishing preflight against the merged commit (pass
`PYRIC_PUBLISH_TAG=exp` when rehearsing an `exp` channel cut):

```bash
bun run release:preflight "$RELEASE_VERSION"
# Or for the exp channel:
PYRIC_PUBLISH_TAG=exp bun run release:preflight "$RELEASE_VERSION"
```

The preflight:

1. checks that the npm account can publish all six packages, with read-only
   requests (see [Publish access is checked first](#publish-access-is-checked-first));
2. runs the complete test suite;
3. builds and packs the release tarballs into `dist/packages/`, the one pack
   of the run, recording each tarball's sha256 and the commit and clean state
   it packed in `manifest.json`, and re-verifies packed `@pyric/rules` `dist/`
   bytes against npm;
4. runs the packaging gate on those tarballs, which lints them and installs
   them in a fresh consumer;
5. runs the installed-tarball behaviour smoke and the app scenarios on the
   same tarballs, then stamps them in `dist/packages/proven.json`, but only if
   they are still the bytes the pack wrote, on the tree it packed;
6. copies the six tarballs into a directory of its own and verifies the
   copies against the stamp;
7. verifies npm authentication with a read-only `npm whoami` request, and runs
   `npm publish --dry-run` for each of the six copies; and
8. runs the full compatibility check and calculates the `fb<major>.<minor>`
   compatibility tag.

The preflight branch exits before the real publish loop and never invokes
`npm dist-tag add`. Its final message must say that no packages or dist-tags
were published or changed.

Stop if any step fails. Fix the failure, merge the fix, update `main`, and run
the preflight again on the new merged commit. Do not proceed on the strength of
an earlier successful run from a different commit.

## 4. Publish the verified commit

Publishing is irreversible once the first package upload succeeds. Make one
last check that the checkout is still clean and still has the release version,
then run the repository publisher:

```bash
git status --short                    # must print nothing
node scripts/lib/check-publish-version.mjs "$RELEASE_VERSION" "$PWD"

# Default latest + alpha + fb<major>.<minor> release:
bash scripts/publish-alpha.sh "$RELEASE_VERSION"

# Or cut only to the exp dist-tag (no alpha/latest move on existing packages, no fb tag):
PYRIC_PUBLISH_TAG=exp bash scripts/publish-alpha.sh "$RELEASE_VERSION"
```

Do not set `PYRIC_PUBLISH_SKIP_GATES=1` for a normal release. The real publish
deliberately repeats the tests, the build and pack, and every gate on the
packed tarballs before uploading anything, and it uploads the tarballs those
gates tested.

`PYRIC_PUBLISH_SKIP_GATES=1` is for a rerun after a failure before the first
upload, such as npm authentication. It skips the gates and the pack, and checks
the stamp first. It goes on only when `proven.json` names the current commit
and version, the tree was clean then and is clean now (untracked files count),
and the exact uploaded tarballs match their sha256. Otherwise it stops in
seconds, before uploading anything.

## 5. Verify npm and tag the commit

Do not create the Git tag until the publisher has completed successfully and
all six versions are visible in npm:

```bash
for package_name in pyric pyric-admin create-pyric @pyric/cli @pyric/ui @pyric/live; do
  npm view "${package_name}@${RELEASE_VERSION}" version
  npm dist-tag ls "$package_name"
done
```

Each version lookup must print `$RELEASE_VERSION`. Confirm that the expected
channel dist-tags (`alpha` + `latest` + `fb*` on a default release, or `exp` on
a `PYRIC_PUBLISH_TAG=exp` release; remember that a brand-new package also
receives `latest` on its first upload) point at it. Then pin the exact published
commit:

```bash
git status --short                    # must print nothing
git tag "v${RELEASE_VERSION}"
git push origin "v${RELEASE_VERSION}"
```

This tag is the recovery point for a release branch or hotfix while `main`
continues to move.

## 6. Deploy the documentation site when required

If the public site should track this release, use its deployment wrapper after
the npm release and Git tag are confirmed:

```bash
bash scripts/deploy-site.sh
```

The script rebuilds the packages, composes `dist/site`, verifies that the site
entry point exists, and deploys Firebase Hosting only.

## If publishing stops part-way through

Do not immediately rerun the publisher: npm versions are immutable, so an
already-uploaded package version cannot be published again. First inspect the
packages with the read-only verification loop above and record which uploads and
dist-tags succeeded.

Do not create the Git tag or deploy the site while the package set is partial.
Recover deliberately from the published state; do not bump to another version
or move compatibility tags by hand merely to make the checklist green.
