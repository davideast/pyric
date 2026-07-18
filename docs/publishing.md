# How to publish Pyric to npm

This guide publishes the five npm packages from a reviewed, merged release
commit. Use the repository scripts for every version bump, verification, pack,
and publish operation. Do not edit package versions or run `npm publish`
directly.

Run every command from the repository root.

## Before you start

You need:

- push and pull-request access to `davideast/pyric`;
- publish access to `pyric`, `pyric-admin`, `create-pyric`, `@pyric/cli`, and
  `@pyric/ui`;
- an npm granular access token configured in your user-level `~/.npmrc` with
  read/write access to those five packages and bypass 2FA enabled;
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

Choose the next version and keep it in one shell variable for the entire
release:

```bash
RELEASE_VERSION=0.1.0-alpha.11
```

## 1. Prepare the release pull request

Start from a clean checkout. The preparation script fetches `origin/main`,
creates `release/v<version>` from that exact commit, bumps all five package
manifests in lockstep, refreshes `bun.lock`, verifies the resulting versions,
commits the change, pushes the branch, and opens the release pull request with
its changelog.

```bash
git status --short                    # must print nothing
bash scripts/prepare-release.sh "$RELEASE_VERSION"
```

Review the pull request and let its required checks finish. The release diff
should contain only the intended lockstep version changes and lockfile refresh.
Merge the pull request; do not publish from the release branch.

If the script refuses a dirty working tree, preserve or finish that work before
trying again. Do not bypass the cleanliness check.

## 2. Check out the merged release commit

Return to `main`, update it without creating a merge commit, and verify that the
five publishable package manifests all contain the requested version:

```bash
git switch main
git pull --ff-only origin main
git status --short                    # must print nothing
node scripts/lib/check-publish-version.mjs "$RELEASE_VERSION" "$PWD"
```

The version checker is the same guard used by the publish script. A mismatch
stops the release before building or contacting the npm publishing endpoints.

## 3. Rehearse the complete release without publishing

Run the non-publishing preflight against the merged commit:

```bash
bun run release:preflight "$RELEASE_VERSION"
```

The preflight:

1. runs the complete test suite;
2. runs the packaging gate, which packs and installs the packages in a fresh
   consumer;
3. rebuilds and packs the exact release tarballs;
4. runs the installed-tarball behaviour smoke;
5. verifies npm authentication with a read-only `npm whoami` request;
6. runs `npm publish --dry-run` for each of the five tarballs; and
7. runs the full compatibility check and calculates the `fb<major>.<minor>`
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
bash scripts/publish-alpha.sh "$RELEASE_VERSION"
```

Do not set `PYRIC_PUBLISH_SKIP_GATES=1` for a normal release. The real publish
deliberately repeats the tests, packaging gate, rebuild, pack, and installed
tarball smoke before uploading anything.

After those gates pass, `publish-alpha.sh`:

- publishes the five tarballs under the `alpha` dist-tag;
- moves `latest` to the same version for all five packages;
- reruns `compat:check` against the pinned Firebase version;
- moves the resulting `fb<major>.<minor>` tag for `pyric`, `pyric-admin`,
  `@pyric/cli`, and `@pyric/ui` only when compatibility is green; and
- prints every package's dist-tags for inspection.

`create-pyric` intentionally receives `alpha` and `latest`, but no Firebase
compatibility tag.

## 5. Verify npm and tag the commit

Do not create the Git tag until the publisher has completed successfully and
all five versions are visible in npm:

```bash
for package_name in pyric pyric-admin create-pyric @pyric/cli @pyric/ui; do
  npm view "${package_name}@${RELEASE_VERSION}" version
  npm dist-tag ls "$package_name"
done
```

Each version lookup must print `$RELEASE_VERSION`. Confirm that `alpha` and
`latest` point at it, and that the four compatible runtime packages carry the
expected `fb` tag. Then pin the exact published commit:

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
five packages with the read-only verification loop above and record which
uploads and dist-tags succeeded.

Do not create the Git tag or deploy the site while the package set is partial.
Recover deliberately from the published state; do not bump to another version
or move compatibility tags by hand merely to make the checklist green.
