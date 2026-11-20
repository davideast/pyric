import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'firestore-kotlin'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO = '# Kotlin Cloud Firestore integration compatibility\n\n## Status legend\n\n| Status | Meaning |\n|---|---|\n| \u2713 | **Conforming** \u2014 Kotlin conformance test matches com.google.firebase.firestore specification |\n| \u26a0 | **Diverged (documented)** \u2014 intentional difference with a written reason |\n| \u2717 | **Bug** \u2014 should match com.google.firebase.firestore specification but does not |\n| \u2014 | **Not implemented yet** \u2014 explicitly outside the implemented slice |\n| ? | **Unverified** \u2014 com.google.firebase.firestore behavior not yet verified by conformance test |\n';

export const firestoreKotlinRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const firestoreKotlinRegistry: CompatibilitySurfaceRegistry = {
  surface: 'firestore-kotlin',
  label: 'Firestore \u00b7 Kotlin',
  compatPath: 'packages/conformance/docs/firestore-kotlin/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default firestoreKotlinRegistry;
