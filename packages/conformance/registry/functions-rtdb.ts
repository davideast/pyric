import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'functions-rtdb'), {
  ignoreFiles: new Set(['defaults.ts']),
});

export const functionsRtdbRows: CompatibilityRow[] = sections.rowsOf('on-value-created');

const INTRO = `# Firebase Functions RTDB integration compatibility

## Status legend

| Status | Meaning |
|---|---|
| ✓ | **Conforming** — unchanged source matches production under replay |
| ⚠ | **Diverged (documented)** — intentional difference with a written reason |
| ✗ | **Bug** — should match production but does not |
| — | **Not implemented yet** — explicitly outside the implemented slice |
| ? | **Unverified** — production target or local replay is incomplete |
`;

export const functionsRtdbRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-rtdb',
  label: 'Functions · RTDB',
  compatPath: 'packages/cli/docs/functions-rtdb/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};
