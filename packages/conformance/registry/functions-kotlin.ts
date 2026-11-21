import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'functions-kotlin'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Cloud Functions \u00b7 Kotlin Compatibility\n\nIntegration compatibility ledger for the Pure-Kotlin Cloud Functions callable client (`packages/kt-client`), conforming to `com.google.firebase:firebase-functions` via the Pyric Functions HTTP gateway and WebSocket bridge.\n';

export const functionsKotlinRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const functionsKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-kotlin',
  label: 'Functions \u00b7 Kotlin',
  compatPath: 'packages/conformance/docs/functions-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default functionsKotlinRegistry;
