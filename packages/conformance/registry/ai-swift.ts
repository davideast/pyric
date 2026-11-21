import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'ai-swift'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase AI Logic \u00b7 Swift Compatibility\n\nIntegration compatibility ledger for the Pure-Swift Firebase AI Logic client (`packages/swift-client`), conforming to `FirebaseAILogic` via the Pyric WebSocket bridge and `AiBroker`.\n';

export const aiSwiftRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const aiSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'ai-swift',
  label: 'AI Logic \u00b7 Swift',
  compatPath: 'packages/conformance/docs/ai-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default aiSwiftRegistry;
