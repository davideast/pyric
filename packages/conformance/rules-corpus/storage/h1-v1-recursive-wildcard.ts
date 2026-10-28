/**
 * ─── Candidate scenario (hunt H1, ST-H1-2): h1-v1-recursive-wildcard ─────────
 * A ruleset with no rules_version (production defaults it to version 1). The
 * Storage docs: "In version 1, recursive wildcards match one or more filename
 * elements, not zero or more elements. Thus, match
 * /images/{filenamePrefixWildcard}/{imageFilename=**} matches a filename like
 * /images/profilePics/profile.png, but not /images/badge.png."
 * (https://firebase.google.com/docs/storage/security/core-syntax)
 *
 * pyric matches zero or more segments whatever the version, so it ALLOWs the
 * badge.png and whole-glob root cases below.
 */
import type { StorageScenarioRecord } from './types.ts';

export const scenario: StorageScenarioRecord = {
  fm: 'STORAGE-H1-V1-GLOB',
  rationale:
    'Version 1 recursive wildcards need at least one segment; a zero-segment match is an ALLOW production never grants.',
  rules: `service firebase.storage {
  match /b/{bucket}/o {
    match /images/{filenamePrefixWildcard}/{imageFilename=**} {
      allow read: if true;
    }
    match /docs/{all=**} {
      allow read: if all is path || all is string;
    }
  }
}`,
  cases: [
    { description: 'v1 glob: two segments under the prefix wildcard allow (pyric ALLOW)', expectation: 'ALLOW', method: 'get', path: 'images/profilePics/profile.png' },
    { description: 'v1 glob: zero segments for the glob deny (pyric ALLOW)', expectation: 'DENY', method: 'get', path: 'images/badge.png' },
    { description: 'v1 glob: one segment under a bare glob allows (pyric ALLOW)', expectation: 'ALLOW', method: 'get', path: 'docs/a.txt' },
    { description: 'v1 glob: the glob type is path or string (pyric ALLOW)', expectation: 'ALLOW', method: 'get', path: 'docs/a/b.txt' },
  ],
};
