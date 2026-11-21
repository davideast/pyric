import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'storage-flutter'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Cloud Storage \u00b7 Flutter Compatibility\n\nIntegration compatibility ledger for the Pure-Dart Flutter Cloud Storage client (`packages/flutter-client`), conforming to `firebase_storage_platform_interface` via Pyric WebSocket bridge and HTTP byte-route transport.\n';

export const storageFlutterRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const storageFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'storage-flutter',
  label: 'Cloud Storage \u00b7 Flutter',
  compatPath: 'packages/conformance/docs/storage-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default storageFlutterRegistry;
