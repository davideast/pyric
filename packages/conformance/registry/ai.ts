import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_CHECK_AI_SUITE } from './ai/app-check-passthrough/section.ts';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

/**
 * The ai surface registry, admitted at zero under Conformance Driven
 * Development (map https://github.com/davideast/pyric/issues/92).
 *
 * Every row was born status 'unverified' and automation 'unverified'; the
 * red conformance suites under packages/pyric/test/ai named every
 * row id and failed by design until the mirror landed. The mirror is in
 * (commit e0cea50) and the climb lane passes 80 of 80 with no assertion
 * weakened, so every row is flipped: the automation field records the
 * evidence tier per packages/conformance/docs/ai/cdd-deltas.md, and status records
 * conformance, with six documented divergences from the installed 2.12.0
 * pinned in row notes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'ai'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const header = `# \`pyric/ai\` compatibility matrix

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming**: sandbox matches prod, locked by a passing probe |
| ⚠ | **Diverged (documented)**: intentional difference with a written reason |
| ✗ | **Bug**: should match prod but doesn't; failing probe pins it |
| — | **Not implemented yet** — deliberately or pending |
| ? | **Unverified**: claim not yet locked by a passing probe |
`;

export { APP_CHECK_AI_SUITE };
export const appCheckAiRows: CompatibilityRow[] = sections.rowsOf('app-check-passthrough');
export const sandboxAppCheckAiRows: CompatibilityRow[] = sections.rowsOf('sandbox-app-check');

export const aiRegistry: CompatibilitySurfaceRegistry = {
  surface: 'ai',
  label: 'AI Logic',
  compatPath: 'packages/pyric/docs/ai/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: header },
    ...sections.blocks,
  ],
};
