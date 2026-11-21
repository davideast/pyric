import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'functions-swift'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Cloud Functions \u00b7 Swift Compatibility\n\nIntegration compatibility ledger for the Pure-Swift Cloud Functions callable client (`packages/swift-client`, `PyricFunctions`), conforming to `FirebaseFunctions` via the Pyric Functions HTTP gateway and WebSocket bridge.\n';

export const functionsSwiftRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const functionsSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-swift',
  label: 'Functions \u00b7 Swift',
  compatPath: 'packages/conformance/docs/functions-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default functionsSwiftRegistry;
