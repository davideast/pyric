import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'ai-kotlin'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase AI Logic \u00b7 Kotlin Compatibility\n\nIntegration compatibility ledger for the Pure-Kotlin Firebase AI Logic client (`packages/kt-client`), conforming to `com.google.firebase:firebase-ai` via the Pyric WebSocket bridge and `AiBroker`.\n';

export const aiKotlinRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const aiKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'ai-kotlin',
  label: 'AI Logic \u00b7 Kotlin',
  compatPath: 'packages/conformance/docs/ai-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default aiKotlinRegistry;
