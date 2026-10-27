#!/usr/bin/env bash
# Content keys for the CI dist caches, printed as GitHub Actions outputs:
#
#   packages-key=<sha256>   inputs of `scripts/build.sh --packages-only`
#   site-key=<sha256>       inputs of the full build + composed public site
#
# The keys hash the tracked files the builds read — package sources,
# manifests, the conformance model that feeds @pyric/cli's generated
# projections, and the build scripts themselves. Test suites and the private
# playground are excluded, so a test-only change reuses the cached dist while
# any source change misses.
#
# One thing in the test suites is a build input: the generated conformance
# projection links each registry row's cited test files at a line number. So
# both keys also hash the list of those (row, file, line) anchors, which
# packages/conformance/src/test-line-anchors.ts prints. A test-only change
# that moves a cited line misses; one that moves none still hits (#1265).
#
# Exact-match only: the workflow must not add restore-keys, because a
# near-miss restore would run tests against stale artifacts (fail-closed,
# same posture as scripts/ci/required.ts).
set -euo pipefail

hash_tracked() {
  git ls-files -z -- "$@" | LC_ALL=C sort -z \
    | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}

packages_key=$(hash_tracked \
  'packages/' \
  ':(glob,exclude)packages/*/test/**' \
  ':!packages/playground' \
  ':!packages/site-docs' \
  'scripts/build.sh' \
  'bun.lock')

site_key=$(hash_tracked \
  'packages/' \
  ':(glob,exclude)packages/*/test/**' \
  ':!packages/playground' \
  'scripts/build.sh' \
  'scripts/build-site.sh' \
  'scripts/site/' \
  'bun.lock')

# The cited test lines the conformance projection links to. Fails closed: a
# key computed without them, or with an empty list, could restore a
# projection with stale links.
anchor_list=$(bun packages/conformance/src/test-line-anchors.ts)
if [ -z "$anchor_list" ]; then
  echo "build-input-key: packages/conformance/src/test-line-anchors.ts listed no cited test lines" >&2
  exit 1
fi
anchors=$(printf '%s\n' "$anchor_list" | sha256sum | cut -d' ' -f1)
with_anchors() {
  printf '%s %s' "$1" "$anchors" | sha256sum | cut -d' ' -f1
}

echo "packages-key=$(with_anchors "$packages_key")"
echo "site-key=$(with_anchors "$site_key")"
