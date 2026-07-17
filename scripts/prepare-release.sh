#!/usr/bin/env bash
# Author the ceremonial release PR: lockstep version bump + changelog.
#
#   bash scripts/prepare-release.sh 0.1.0-alpha.10
#
# The release PR is the changelog point. Merging it marks the release cut;
# publishing is still deliberate:
#
#   1. bash scripts/prepare-release.sh <version>   (this script: branch, bump, PR)
#   2. review + merge the PR                       (the ceremony / changelog)
#   3. bash scripts/publish-alpha.sh <version>     (from the merged main checkout)
#   4. git tag v<version> && git push origin v<version>
#
# The tag pins the published commit so a hotfix can branch from it while main
# carries in-flight refactors (git checkout -b release/<version> v<version>).
#
# What this script does NOT do: publish, tag, run the test suites, or deploy
# the site. It only authors the bump the publish preflight
# (scripts/lib/check-publish-version.mjs) will later verify.
set -euo pipefail

V="${1:?usage: bash scripts/prepare-release.sh <version> (e.g. 0.1.0-alpha.10)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "prepare-release: working tree is not clean" >&2
  exit 1
fi

git fetch -q origin main
BASE="$(git rev-parse origin/main)"
BRANCH="release/v${V}"
git checkout -b "$BRANCH" "$BASE"

# Lockstep bump across the five published packages. create-pyric derives its
# @pyric/cli pin from its own version at runtime, so bumping "version" is the
# whole authoring job.
# Surgical line edit rather than JSON round-trip: parse/stringify rewrites
# unrelated bytes (unicode escapes, key order), which would add noise to the
# ceremonial diff. The preflight below still validates the result semantically.
for dir in pyric pyric-admin create-pyric cli ui; do
  sed -i.bak -E 's/^(  "version": ")[^"]+(",)$/\1'"$V"'\2/' "packages/${dir}/package.json"
  rm -f "packages/${dir}/package.json.bak"
done

# Refresh the lockfile for the new workspace versions, then verify the bump
# with the same preflight publish-alpha.sh runs.
bun install --silent
node scripts/lib/check-publish-version.mjs "$V" "$ROOT"

git add packages/*/package.json bun.lock
git commit -m "release: v${V}"

# Changelog: everything since the previous release tag (fall back to the
# previous version-bump commit when no tag exists yet).
PREV_TAG="$(git describe --tags --abbrev=0 --match 'v*' "$BASE" 2>/dev/null || true)"
if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..${BASE}"
else
  PREV_BUMP="$(git log "$BASE" --format='%H' --grep '^release: v' -n 1 || true)"
  RANGE="${PREV_BUMP:+${PREV_BUMP}..}${BASE}"
fi

BODY_FILE="$(mktemp)"
{
  echo "Release cut for \`${V}\`. Merging this PR marks the release; the changelog below is the record."
  echo
  echo "## Changes since ${PREV_TAG:-the previous release}"
  echo
  git log "$RANGE" --no-merges --format='- %s (%h)'
  echo
  echo "## After merging"
  echo
  echo '- [ ] Full gates on merged main (`bun run test`, packaging gate)'
  echo '- [ ] Manual tarball pass (npm install in a scratch project, can-i-use exact/fuzzy/exit codes, conformance subpaths)'
  echo "- [ ] \`bash scripts/publish-alpha.sh ${V}\` from a clean merged-main checkout (OTP-capable terminal)"
  echo "- [ ] \`git tag v${V} && git push origin v${V}\` on the published commit"
  echo '- [ ] Site deploy (`bash scripts/deploy-site.sh`) if the site should track the release'
} > "$BODY_FILE"

git push -u origin "$BRANCH"
gh pr create --base main --head "$BRANCH" --title "release: v${V}" --body-file "$BODY_FILE"
rm -f "$BODY_FILE"

echo ""
echo "Release PR opened. Merge it to mark the cut, then publish and tag (checklist in the PR body)."
