import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'storage'));

const header = "# `pyric/storage` compatibility matrix\n\n## Status legend\n\n| Status | Meaning |\n|---|---|\n| ✓ | **Conforming** — sandbox matches prod, locked by a passing probe |\n| ⚠ | **Diverged (documented)** — intentional difference with a written reason |\n| ✗ | **Bug** — should match prod but doesn't; failing probe pins it |\n| — | **Not implemented yet** — deliberately or pending |\n| ? | **Unverified** — claim from docs that we haven't yet observed prod-side |\n";

export const storageRegistry: CompatibilitySurfaceRegistry = {
  surface: "storage",
  label: "Storage",
  compatPath: "packages/pyric/docs/storage/COMPAT.md",
  blocks: [
    { kind: 'markdown', markdown: header },
    ...sections.blocks,
  ],
};
