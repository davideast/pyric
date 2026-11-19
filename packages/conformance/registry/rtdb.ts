import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'rtdb'), {
  ignoreFiles: new Set(['defaults.ts']),
});

export const rtdbRegistry = {
  surface: 'rtdb',
  label: 'Realtime Database',
  compatPath: 'packages/pyric/docs/database/COMPAT.md',
  blocks: [
    {
      kind: 'markdown',
      markdown: "# `pyric/database` compatibility matrix\n\n## Status legend\n\n| Status | Meaning |\n|---|---|\n| ✓ | **Conforming** — observable behavior matches Firebase, locked by a passing probe |\n| ⚠ | **Diverged (documented)** — intentional difference with a written reason |\n| ✗ | **Bug** — should match Firebase but does not |\n| — | **Not implemented yet** — pending, or intentionally outside the mirror |\n| ? | **Unverified** — not yet backed by sufficient evidence |\n",
    },
    ...sections.blocks,
  ],
} satisfies CompatibilitySurfaceRegistry;

export default rtdbRegistry;
