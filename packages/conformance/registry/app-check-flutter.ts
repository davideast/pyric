import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'app-check-flutter'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# App Check \u00b7 Flutter Compatibility\n\nIntegration compatibility ledger for the Pure-Dart Flutter App Check client (`packages/flutter-client`, `pyric_app_check.dart`), conforming to `firebase_app_check_platform_interface` via the Pyric WebSocket bridge.\n';

export const appCheckFlutterRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const appCheckFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'app-check-flutter',
  label: 'App Check \u00b7 Flutter',
  compatPath: 'packages/conformance/docs/app-check-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default appCheckFlutterRegistry;
