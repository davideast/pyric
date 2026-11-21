import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'crashlytics-flutter'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase Crashlytics \u00b7 Flutter Compatibility\n\nIntegration compatibility ledger for the Pure-Dart Flutter Firebase Crashlytics client (`packages/flutter-client`), conforming to `firebase_crashlytics` (`pyric_crashlytics`) via the Pyric WebSocket bridge and `CrashlyticsBroker`.\n';

export const crashlyticsFlutterRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const crashlyticsFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'crashlytics-flutter',
  label: 'Crashlytics \u00b7 Flutter',
  compatPath: 'packages/conformance/docs/crashlytics-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default crashlyticsFlutterRegistry;
