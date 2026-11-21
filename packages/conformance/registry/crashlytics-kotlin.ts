import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'crashlytics-kotlin'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase Crashlytics \u00b7 Kotlin Compatibility\n\nIntegration compatibility ledger for the Pure-Kotlin Firebase Crashlytics client (`packages/kt-client`), conforming to `com.google.firebase:firebase-crashlytics` via the Pyric WebSocket bridge and `CrashlyticsBroker`.\n';

export const crashlyticsKotlinRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const crashlyticsKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'crashlytics-kotlin',
  label: 'Crashlytics \u00b7 Kotlin',
  compatPath: 'packages/conformance/docs/crashlytics-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default crashlyticsKotlinRegistry;
