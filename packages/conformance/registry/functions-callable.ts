/**
 * Functions callable `onCall` and the `firebase/functions` client: every row
 * born `unverified` under CDD (`docs/conformance/cdd.md`). The row universe and
 * its evidence plan are `packages/conformance/docs/functions-callable/plan.md`.
 *
 * Each row names its evidence kind:
 * - `observed`: needs a production observation from the functions-callable capture.
 * - `upstream`: stated from firebase-functions 7.2.5, firebase-admin 13.10.0,
 *   and @firebase/functions 0.14.0 (firebase 12.19.0) source.
 * - `pyric`: pyric-owned behavior with no production counterpart.
 *
 * Upstream line references are to `lib/common/providers/https.js` in
 * firebase-functions 7.2.5 unless a row names another file.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'functions-callable'));

export const functionsCallableRows: CompatibilityRow[] = sections.rowsOf('on-call');

const INTRO = `# Firebase Functions callable integration compatibility

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming**: unchanged source matches production under replay |
| ⚠ | **Diverged (documented)**: intentional difference with a written reason |
| ✗ | **Bug**: should match production but does not |
| — | **Not implemented yet**: explicitly outside the implemented slice |
| ? | **Unverified**: production target or local replay is incomplete |
`;

export const functionsCallableRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-callable',
  label: 'Functions · Callable',
  compatPath: 'packages/cli/docs/functions-callable/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};
