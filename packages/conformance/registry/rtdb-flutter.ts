import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'rtdb-flutter'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO = '# Realtime Database \u00b7 Flutter Compatibility\n\nIntegration compatibility ledger for the Pure-Dart Flutter Realtime Database client (`packages/flutter-client`), conforming to `firebase_database` via Pyric WebSocket bridge transport.\n';

export const rtdbFlutterRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const rtdbFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'rtdb-flutter',
  label: 'Realtime Database \u00b7 Flutter',
  compatPath: 'packages/conformance/docs/rtdb-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default rtdbFlutterRegistry;
