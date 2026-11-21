import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'crashlytics-swift'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase Crashlytics \u00b7 Swift Compatibility\n\nIntegration compatibility ledger for the Pure-Swift Firebase Crashlytics client (`packages/swift-client`), conforming to `FirebaseCrashlytics` (`PyricCrashlytics`) via the Pyric WebSocket bridge and `CrashlyticsBroker`.\n';

export const crashlyticsSwiftRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const crashlyticsSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'crashlytics-swift',
  label: 'Crashlytics \u00b7 Swift',
  compatPath: 'packages/conformance/docs/crashlytics-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default crashlyticsSwiftRegistry;
