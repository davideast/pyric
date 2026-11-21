import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'storage-kotlin'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Cloud Storage \u00b7 Kotlin Compatibility\n\nIntegration compatibility ledger for the Pure-Kotlin Cloud Storage client (`packages/kt-client`), conforming to `com.google.firebase:firebase-storage` via Pyric WebSocket bridge and HTTP byte-route transport.\n';

export const storageKotlinRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const storageKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'storage-kotlin',
  label: 'Cloud Storage \u00b7 Kotlin',
  compatPath: 'packages/conformance/docs/storage-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default storageKotlinRegistry;
