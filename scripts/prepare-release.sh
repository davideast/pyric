#!/usr/bin/env bash
# Author the ceremonial release PR: version bump + changelog.
#
#   bash scripts/prepare-release.sh 0.1.0-alpha.36
#   bash scripts/prepare-release.sh --package rules 0.1.1
#
# The release PR is the changelog point. Merging it marks the release cut;
# publishing is still deliberate:
#
#   1. bash scripts/prepare-release.sh [--package rules] <version>
#   2. review + merge the PR
#   3. bash scripts/publish-alpha.sh [--package rules] <version>
#   4. git tag <tag> && git push origin <tag>   (v<version> or rules-v<version>)
#
# What this script does NOT do: publish, tag, run the test suites, or deploy
# the site. It only authors the bump the publish preflight
# (scripts/lib/check-publish-version.mjs) will later verify.
set -euo pipefail

PACKAGE_TARGET="pyric"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --package)
      PACKAGE_TARGET="${2:?--package needs pyric or rules}"
      shift 2
      ;;
    --package=*)
      PACKAGE_TARGET="${1#--package=}"
      shift
      ;;
    -*)
      echo "prepare-release: unknown flag $1 (expected [--package pyric|rules] <version>)" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

case "$PACKAGE_TARGET" in
  pyric) ;;
  rules|@pyric/rules) PACKAGE_TARGET="rules" ;;
  *)
    echo "prepare-release: unknown --package '$PACKAGE_TARGET' (expected pyric or rules)" >&2
    exit 2
    ;;
esac

V="${1:?usage: bash scripts/prepare-release.sh [--package pyric|rules] <version>}"
shift
if [ "$#" -ne 0 ]; then
  echo "prepare-release: unexpected argument(s) after version '$V': $* (flags must precede <version>)" >&2
  exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -n "$(git status --porcelain)" ]; then
  echo "prepare-release: working tree is not clean" >&2
  exit 1
fi

git fetch -q origin main
BASE="$(git rev-parse origin/main)"
if [ "$PACKAGE_TARGET" = "rules" ]; then
  TAG_PREFIX="rules-v"
  BRANCH="release/rules-v${V}"
  COMMIT_TITLE="release: rules-v${V}"
else
  TAG_PREFIX="v"
  BRANCH="release/v${V}"
  COMMIT_TITLE="release: v${V}"
fi
git checkout -b "$BRANCH" "$BASE"

# Surgical line edit rather than JSON round-trip: parse/stringify rewrites
# unrelated bytes (unicode escapes, key order), which would add noise to the
# ceremonial diff. The preflight below still validates the result semantically.
if [ "$PACKAGE_TARGET" = "rules" ]; then
  sed -i.bak -E 's/^(  "version": ")[^"]+("[,]?)$/\1'"$V"'\2/' "packages/rules/package.json"
  rm -f "packages/rules/package.json.bak"
else
  # Lockstep bump across the six published packages. create-pyric derives its
  # @pyric/cli pin from its own version at runtime, so bumping "version" is the
  # whole authoring job.
  for dir in pyric pyric-admin create-pyric cli ui live; do
    sed -i.bak -E 's/^(  "version": ")[^"]+("[,]?)$/\1'"$V"'\2/' "packages/${dir}/package.json"
    rm -f "packages/${dir}/package.json.bak"
  done
fi

# Refresh the lockfile for the new workspace versions, then verify the bump
# with the same preflight publish-alpha.sh runs.
bun install --silent
node scripts/lib/check-publish-version.mjs --package "$PACKAGE_TARGET" "$V" "$ROOT"

if [ "$PACKAGE_TARGET" = "rules" ]; then
  git add packages/rules/package.json bun.lock
else
  git add packages/*/package.json bun.lock
fi

if git diff --cached --quiet; then
  echo "prepare-release: manifests are already at ${V}; nothing to bump (run preflight/publish from main)" >&2
  exit 1
fi

git commit -m "$COMMIT_TITLE"

# Changelog: everything since the previous release tag on the selected line
# (fall back to the previous version-bump commit when no tag exists yet).
PREV_TAG="$(git describe --tags --abbrev=0 --match "${TAG_PREFIX}*" "$BASE" 2>/dev/null || true)"
if [ -n "$PREV_TAG" ]; then
  RANGE="${PREV_TAG}..${BASE}"
else
  PREV_BUMP="$(git log "$BASE" --format='%H' --grep "^release: ${TAG_PREFIX}" -n 1 || true)"
  RANGE="${PREV_BUMP:+${PREV_BUMP}..}${BASE}"
fi

BODY_FILE="$(mktemp)"
trap 'rm -f "${BODY_FILE:-}"' EXIT
if [ "$PACKAGE_TARGET" = "rules" ]; then
  {
    echo "Release cut for \`@pyric/rules@${V}\`. Merging this PR marks the release; verify \`packages/rules/CHANGELOG.md\` covers \`${V}\` before merging."
    echo
    echo "## Changes in \`packages/rules\` since ${PREV_TAG:-the previous rules release}"
    echo
    git log "$RANGE" --no-merges --format='- %s (%h)' -- packages/rules
    echo
    echo "## After merging"
    echo
    echo "- [ ] \`bun run release:preflight --package rules ${V}\` from a clean merged-main checkout (prefix with \`PYRIC_PUBLISH_SCOPE_WRITE=@pyric\` if \`@pyric/rules\` is not on npm yet); confirm it reports that no packages or dist-tags changed"
    echo "- [ ] \`bash scripts/publish-alpha.sh --package rules ${V}\` from that same clean merged-main commit after the preflight succeeds"
    echo "- [ ] \`git tag rules-v${V} && git push origin rules-v${V}\` on the published commit"
  } > "$BODY_FILE"
else
  {
    echo "Release cut for \`${V}\`. Merging this PR marks the release; the changelog below is the record."
    echo
    echo "## Changes since ${PREV_TAG:-the previous release}"
    echo
    git log "$RANGE" --no-merges --format='- %s (%h)'
    echo
    echo "## After merging"
    echo
    echo "- [ ] \`bun run release:preflight ${V}\` from a clean merged-main checkout; confirm it reports that no packages or dist-tags changed"
    echo "- [ ] \`bash scripts/publish-alpha.sh ${V}\` from that same clean merged-main commit after the preflight succeeds"
    echo "- [ ] \`git tag v${V} && git push origin v${V}\` on the published commit"
    echo '- [ ] Site deploy (`bash scripts/deploy-site.sh`) if the site should track the release'
  } > "$BODY_FILE"
fi

git push -u origin "$BRANCH"
gh pr create --base main --head "$BRANCH" --title "$COMMIT_TITLE" --body-file "$BODY_FILE" --label ci-packaging
rm -f "$BODY_FILE"

echo ""
echo "Release PR opened. Merge it to mark the cut, then publish and tag (checklist in the PR body)."
