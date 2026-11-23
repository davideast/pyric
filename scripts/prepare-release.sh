#!/usr/bin/env bash
# Author the ceremonial release PR: version bump + changelog.
#
#   bash scripts/prepare-release.sh 0.1.0-alpha.36
#   bash scripts/prepare-release.sh --base rc/0.1.0-alpha.36 0.1.0-alpha.36
#   bash scripts/prepare-release.sh --package rules 0.1.1
#   bash scripts/prepare-release.sh --package rules --base rc/0.1.0-alpha.36 0.1.1
#
# By default, branches from `origin/main` and opens the PR against `main`.
# When `--base <ref>` resolves to an older commit merged to `main` (after `main`
# has moved ahead), pushes `release-base/<tag>` at that pinned commit and opens
# the release PR against `release-base/<tag>` so CI proves the pinned tree +
# version bump without pulling in newer `main` commits.
#
# What this script does NOT do: publish, tag, run the test suites, or deploy
# the site. It only authors the bump the publish preflight
# (scripts/lib/check-publish-version.mjs) will later verify.
set -euo pipefail
{

PACKAGE_TARGET="pyric"
BASE_REF=""
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
    --base)
      if [ "$#" -lt 2 ] || [ -z "${2:-}" ]; then
        echo "prepare-release: --base requires a non-empty git ref" >&2
        exit 2
      fi
      BASE_REF="$2"
      shift 2
      ;;
    --base=*)
      BASE_REF="${1#--base=}"
      if [ -z "$BASE_REF" ]; then
        echo "prepare-release: --base requires a non-empty git ref" >&2
        exit 2
      fi
      shift
      ;;
    -*)
      echo "prepare-release: unknown flag $1 (expected [--package pyric|rules] [--base <ref>] <version>)" >&2
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

V="${1:?usage: bash scripts/prepare-release.sh [--package pyric|rules] [--base <ref>] <version>}"
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

git fetch -q origin main --tags
MAIN_SHA="$(git rev-parse origin/main)"
if [ -n "$BASE_REF" ]; then
  BASE="$(git rev-parse --verify "${BASE_REF}^{commit}" 2>/dev/null || true)"
  if [ -z "$BASE" ] && git fetch -q origin "$BASE_REF" 2>/dev/null; then
    BASE="$(git rev-parse --verify "FETCH_HEAD^{commit}" 2>/dev/null || true)"
  fi
  if [ -z "$BASE" ]; then
    echo "prepare-release: unknown --base ref '$BASE_REF'" >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$BASE" "$MAIN_SHA"; then
    echo "prepare-release: --base '$BASE_REF' ($BASE) is not an ancestor of origin/main ($MAIN_SHA); releases must cut from commits merged to main" >&2
    exit 1
  fi
else
  BASE="$MAIN_SHA"
fi

if [ "$PACKAGE_TARGET" = "rules" ]; then
  TAG_PREFIX="rules-v"
else
  TAG_PREFIX="v"
fi
TAG_NAME="${TAG_PREFIX}${V}"
BRANCH="release/${TAG_NAME}"
COMMIT_TITLE="release: ${TAG_NAME}"

PINNED_BASE=0
PR_BASE="main"
if [ "$BASE" != "$MAIN_SHA" ]; then
  PINNED_BASE=1
  PR_BASE="release-base/${TAG_NAME}"
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
  echo "prepare-release: manifests are already at ${V}; nothing to bump (run preflight/publish from ${PR_BASE})" >&2
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

SHORT_BASE="${BASE:0:9}"
CHECKOUT_NOTE="clean merged-main checkout"
if [ "$PINNED_BASE" -eq 1 ]; then
  CHECKOUT_NOTE="clean detached \`origin/${PR_BASE}\` checkout"
fi

BODY_FILE="$(mktemp)"
trap 'rm -f "${BODY_FILE:-}"' EXIT
if [ "$PACKAGE_TARGET" = "rules" ]; then
  {
    if [ "$PINNED_BASE" -eq 1 ]; then
      echo "Pinned-base release cut for \`@pyric/rules@${V}\` from \`${BASE_REF}\` (\`${SHORT_BASE}\`) while \`main\` has moved ahead; verify \`packages/rules/CHANGELOG.md\` covers \`${V}\` before merging. Merge directly into \`${PR_BASE}\` via \`gh pr merge --merge\` once required CI checks are green (do not add \`merge-queue\`, which targets \`main\`)."
    else
      echo "Release cut for \`@pyric/rules@${V}\`. Merging this PR marks the release; verify \`packages/rules/CHANGELOG.md\` covers \`${V}\` before merging."
    fi
    echo
    echo "## Changes in \`packages/rules\` since ${PREV_TAG:-the previous rules release}"
    echo
    git log "$RANGE" --no-merges --format='- %s (%h)' -- packages/rules
    echo
    echo "## After merging"
    echo
    if [ "$PINNED_BASE" -eq 1 ]; then
      echo "- [ ] \`git fetch origin ${PR_BASE} && git switch --detach origin/${PR_BASE} && bun install --frozen-lockfile\`"
    fi
    echo "- [ ] \`bun run release:preflight --package rules ${V}\` from a ${CHECKOUT_NOTE} (prefix with \`PYRIC_PUBLISH_SCOPE_WRITE=@pyric\` if \`@pyric/rules\` is not on npm yet); confirm it reports that no packages or dist-tags changed"
    echo "- [ ] \`bash scripts/publish-alpha.sh --package rules ${V}\` from that same ${CHECKOUT_NOTE} after the preflight succeeds"
    echo "- [ ] \`git tag ${TAG_NAME} && git push origin ${TAG_NAME}\` on the published commit"
    if [ "$PINNED_BASE" -eq 1 ]; then
      echo "- [ ] \`git push origin --delete ${PR_BASE}\` after pushing \`${TAG_NAME}\`"
      echo "- [ ] Back-sync \`${TAG_NAME}\` into \`main\` without publishing \`main\` (see \`docs/publishing.md\` pinned-commit section)"
    fi
  } > "$BODY_FILE"
else
  {
    if [ "$PINNED_BASE" -eq 1 ]; then
      echo "Pinned-base release cut for \`${V}\` from \`${BASE_REF}\` (\`${SHORT_BASE}\`) while \`main\` has moved ahead. Merge directly into \`${PR_BASE}\` via \`gh pr merge --merge\` once required CI checks are green (do not add \`merge-queue\`, which targets \`main\`)."
    else
      echo "Release cut for \`${V}\`. Merging this PR marks the release; the changelog below is the record."
    fi
    echo
    echo "## Changes since ${PREV_TAG:-the previous release}"
    echo
    git log "$RANGE" --no-merges --format='- %s (%h)'
    echo
    echo "## After merging"
    echo
    if [ "$PINNED_BASE" -eq 1 ]; then
      echo "- [ ] \`git fetch origin ${PR_BASE} && git switch --detach origin/${PR_BASE} && bun install --frozen-lockfile\`"
    fi
    echo "- [ ] \`bun run release:preflight ${V}\` from a ${CHECKOUT_NOTE}; confirm it reports that no packages or dist-tags changed"
    echo "- [ ] \`bash scripts/publish-alpha.sh ${V}\` from that same ${CHECKOUT_NOTE} after the preflight succeeds"
    echo "- [ ] \`git tag ${TAG_NAME} && git push origin ${TAG_NAME}\` on the published commit"
    if [ "$PINNED_BASE" -eq 1 ]; then
      echo "- [ ] \`git push origin --delete ${PR_BASE}\` after pushing \`${TAG_NAME}\`"
      echo "- [ ] Back-sync \`${TAG_NAME}\` into \`main\` without publishing \`main\` (see \`docs/publishing.md\` pinned-commit section)"
    else
      echo '- [ ] Site deploy (`bash scripts/deploy-site.sh`) if the site should track the release'
    fi
  } > "$BODY_FILE"
fi

if [ "$PINNED_BASE" -eq 1 ]; then
  git push origin "${BASE}:refs/heads/${PR_BASE}"
fi
git push -u origin "$BRANCH"
gh pr create --base "$PR_BASE" --head "$BRANCH" --title "$COMMIT_TITLE" --body-file "$BODY_FILE" --label ci-packaging
rm -f "$BODY_FILE"

echo ""
echo "Release PR opened against ${PR_BASE}. Merge it to mark the cut, then publish and tag (checklist in the PR body)."
exit 0
}
