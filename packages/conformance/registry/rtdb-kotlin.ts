import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'rtdb-kotlin'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO = `# Realtime Database · Kotlin Compatibility

Integration compatibility ledger for the Pure-Kotlin Realtime Database client (\`packages/kt-client\`), conforming to \`com.google.firebase:firebase-database\` via Pyric WebSocket bridge transport.
`;

export const rtdbKotlinRows: CompatibilityRow[] = sections.blocks.flatMap((block) => block.rows);

export const rtdbKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'rtdb-kotlin',
  label: 'Realtime Database · Kotlin',
  compatPath: 'packages/conformance/docs/rtdb-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default rtdbKotlinRegistry;
