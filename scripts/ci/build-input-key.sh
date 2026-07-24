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
# any source change misses. Exact-match only: the workflow must not add
# restore-keys, because a near-miss restore would run tests against stale
# artifacts (fail-closed, same posture as scripts/ci/required.ts).
set -euo pipefail

hash_tracked() {
  git ls-files -z -- "$@" | LC_ALL=C sort -z \
    | xargs -0 sha256sum | sha256sum | cut -d' ' -f1
}

packages_key=$(hash_tracked \
  'packages/' \
  ':!packages/*/test' \
  ':!packages/playground' \
  ':!packages/site-docs' \
  'scripts/build.sh' \
  'bun.lock')

site_key=$(hash_tracked \
  'packages/' \
  ':!packages/*/test' \
  ':!packages/playground' \
  'scripts/build.sh' \
  'scripts/build-site.sh' \
  'scripts/site/' \
  'bun.lock')

echo "packages-key=${packages_key}"
echo "site-key=${site_key}"
