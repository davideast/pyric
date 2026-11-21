import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'storage-swift'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Cloud Storage \u00b7 Swift Compatibility\n\nIntegration compatibility ledger for the Pure-Swift Cloud Storage client (`packages/swift-client`), conforming to `FirebaseStorage` via Pyric WebSocket bridge and HTTP byte-route transport.\n';

export const storageSwiftRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const storageSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'storage-swift',
  label: 'Cloud Storage \u00b7 Swift',
  compatPath: 'packages/conformance/docs/storage-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default storageSwiftRegistry;
