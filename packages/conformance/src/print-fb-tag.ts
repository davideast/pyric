#!/usr/bin/env bun
// Prints the `fb<major>.<minor>` dist-tag derived from the pinned Firebase
// version, and only that — no other output, so a caller can capture stdout
// directly (`FB_TAG="$(bun run packages/conformance/src/print-fb-tag.ts)"`).
//
// The pin is FIREBASE_TESTED_AGAINST (packages/cli/src/version/
// compat-target.ts) — the same constant `pyric --version` prints. The patch
// component is discarded when forming the tag: pyric tags Firebase's major
// and minor lines, never its patch level (see
// packages/site-docs/src/content/pyric/explanation/versioning-and-compatibility.md).
import { FIREBASE_TESTED_AGAINST } from '../../../packages/cli/src/version/compat-target.ts';

const [major, minor] = FIREBASE_TESTED_AGAINST.split('.');
if (!major || !minor) {
  throw new Error(`FIREBASE_TESTED_AGAINST is not major.minor.patch: "${FIREBASE_TESTED_AGAINST}"`);
}
process.stdout.write(`fb${major}.${minor}\n`);
