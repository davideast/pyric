import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'messaging-swift'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase Cloud Messaging \u00b7 Swift Compatibility\n\nIntegration compatibility ledger for the Pure-Swift Firebase Cloud Messaging client (`packages/swift-client`), conforming to `FirebaseMessaging` (`PyricMessaging`) via the Pyric WebSocket bridge and `MessagingBroker`.\n';

export const messagingSwiftRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const messagingSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'messaging-swift',
  label: 'Messaging \u00b7 Swift',
  compatPath: 'packages/conformance/docs/messaging-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default messagingSwiftRegistry;
