import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'messaging-flutter'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase Cloud Messaging \u00b7 Flutter Compatibility\n\nIntegration compatibility ledger for the Pure-Dart Flutter Firebase Cloud Messaging client (`packages/flutter-client`), conforming to `firebase_messaging` (`pyric_messaging`) via the Pyric WebSocket bridge and `MessagingBroker`.\n';

export const messagingFlutterRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const messagingFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'messaging-flutter',
  label: 'Messaging \u00b7 Flutter',
  compatPath: 'packages/conformance/docs/messaging-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default messagingFlutterRegistry;
