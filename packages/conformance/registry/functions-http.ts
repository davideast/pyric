/**
 * Functions HTTP `onRequest`: every row born `unverified` under CDD
 * (`docs/conformance/cdd.md`). The row universe and its evidence plan are
 * `packages/conformance/docs/functions-http/plan.md`.
 *
 * Each row names its evidence kind:
 * - `observed`: needs a production observation from the `functions-http` rig.
 * - `upstream`: stated from firebase-functions 7.2.5 / firebase-tools 15.23.0 source.
 * - `pyric`: pyric-owned behavior with no production counterpart.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'functions-http'), {
  ignoreFiles: new Set(['defaults.ts']),
});

export const functionsHttpRows: CompatibilityRow[] = sections.rowsOf('on-request');

const INTRO = `# Firebase Functions HTTP integration compatibility

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming**: unchanged source matches production under replay |
| ⚠ | **Diverged (documented)**: intentional difference with a written reason |
| ✗ | **Bug**: should match production but does not |
| — | **Not implemented yet**: explicitly outside the implemented slice |
| ? | **Unverified**: production target or local replay is incomplete |
`;

export const functionsHttpRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-http',
  label: 'Functions · HTTP',
  compatPath: 'packages/cli/docs/functions-http/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};
