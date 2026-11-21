import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'app-check-swift'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# App Check \u00b7 Swift Compatibility\n\nIntegration compatibility ledger for the Pure-Swift App Check client (`packages/swift-client`, `PyricAppCheck`), conforming to `FirebaseAppCheck` via the Pyric WebSocket bridge.\n';

export const appCheckSwiftRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const appCheckSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'app-check-swift',
  label: 'App Check \u00b7 Swift',
  compatPath: 'packages/conformance/docs/app-check-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default appCheckSwiftRegistry;
