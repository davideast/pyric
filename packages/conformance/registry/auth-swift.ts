import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'auth-swift'), {
  ignoreFiles: new Set(['defaults.ts']),
});

export const authSwiftRows: CompatibilityRow[] = sections.blocks.flatMap((block) => block.rows);

export const authSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'auth-swift',
  label: 'FirebaseAuth Swift',
  compatPath: 'packages/conformance/docs/auth-swift/COMPAT.md',
  blocks: [
    {
      kind: 'markdown',
      markdown: '# FirebaseAuth Swift Conformance\n\nCompatibility reference for Pyric\'s pure-Swift client conforming to `FirebaseAuth` via the Pyric WebSocket bridge.',
    },
    ...sections.blocks,
  ],
};

export default authSwiftRegistry;
