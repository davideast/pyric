import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'ai-flutter'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase AI Logic \u00b7 Flutter Compatibility\n\nIntegration compatibility ledger for the Pure-Flutter Firebase AI Logic client (`packages/flutter-client`), conforming to `firebase_ai` via the Pyric WebSocket bridge and `AiBroker`.\n';

export const aiFlutterRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const aiFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'ai-flutter',
  label: 'AI Logic \u00b7 Flutter',
  compatPath: 'packages/conformance/docs/ai-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default aiFlutterRegistry;
