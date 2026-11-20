import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'firestore-swift'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO = '# Swift Cloud Firestore integration compatibility\n\n## Status legend\n\n| Status | Meaning |\n|---|---|\n| \u2713 | **Conforming** \u2014 Swift test matches FirebaseFirestore API surface |\n| \u26a0 | **Diverged (documented)** \u2014 intentional difference with a written reason |\n| \u2717 | **Bug** \u2014 should match FirebaseFirestore API surface but does not |\n| \u2014 | **Not implemented yet** \u2014 explicitly outside the implemented slice |\n| ? | **Unverified** \u2014 FirebaseFirestore behavior not yet verified locally |\n';

export const firestoreSwiftRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const firestoreSwiftRegistry: CompatibilitySurfaceRegistry = {
  surface: 'firestore-swift',
  label: 'Firestore \u00b7 Swift',
  compatPath: 'packages/conformance/docs/firestore-swift/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default firestoreSwiftRegistry;
