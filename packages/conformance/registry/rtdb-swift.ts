import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'rtdb-swift'), {
  ignoreFiles: new Set(['defaults.ts']),
});

export const rtdbSwiftRows: CompatibilityRow[] = sections.blocks.flatMap((block) => block.rows);

const INTRO = `# Realtime Database · Swift Compatibility

Integration compatibility ledger for the Pure-Swift Realtime Database client (\`packages/swift-client\`), conforming to \`FirebaseDatabase\` via Pyric WebSocket bridge transport.
`;

export const rtdbSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'rtdb-swift',
  label: 'Realtime Database · Swift',
  compatPath: 'packages/conformance/docs/rtdb-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default rtdbSwiftRegistry;
