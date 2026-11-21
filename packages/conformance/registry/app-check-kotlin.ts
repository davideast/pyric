import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'app-check-kotlin'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# App Check \u00b7 Kotlin Compatibility\n\nIntegration compatibility ledger for the Pure-Kotlin App Check client (`packages/kt-client`), conforming to `com.google.firebase:firebase-appcheck` via the Pyric WebSocket bridge.\n';

export const appCheckKotlinRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const appCheckKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'app-check-kotlin',
  label: 'App Check \u00b7 Kotlin',
  compatPath: 'packages/conformance/docs/app-check-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default appCheckKotlinRegistry;
