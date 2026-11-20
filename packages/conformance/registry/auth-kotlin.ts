import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const CONFORMANCE_SUITE = 'packages/kt-client/src/test/kotlin/dev/pyric/auth/ConformanceTest.kt';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'auth-kotlin'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO = `# Auth · Kotlin Conformance

Compatibility reference for Pyric's pure-Kotlin client conforming to \`com.google.firebase.auth\` (Firebase Android SDK) via the Pyric WebSocket bridge.

All rows are backed by the containerized and local test suite (\`${CONFORMANCE_SUITE}\`) executed via the automated CDD climb lane (\`scripts/run-kotlin-auth-conformance.sh\`).
`;

export const authKotlinRows: CompatibilityRow[] = sections.blocks.flatMap((block) => block.rows);

export const authKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'auth-kotlin',
  label: 'Auth · Kotlin',
  compatPath: 'packages/conformance/docs/auth-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default authKotlinRegistry;
