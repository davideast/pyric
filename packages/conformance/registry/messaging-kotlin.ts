import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'messaging-kotlin'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase Cloud Messaging \u00b7 Kotlin Compatibility\n\nIntegration compatibility ledger for the Pure-Kotlin Firebase Cloud Messaging client (`packages/kt-client`), conforming to `com.google.firebase:firebase-messaging` via the Pyric WebSocket bridge and `MessagingBroker`.\n';

export const messagingKotlinRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const messagingKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'messaging-kotlin',
  label: 'Messaging \u00b7 Kotlin',
  compatPath: 'packages/conformance/docs/messaging-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default messagingKotlinRegistry;
