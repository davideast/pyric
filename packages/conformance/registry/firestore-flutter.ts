import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'firestore-flutter'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO = '# Flutter Cloud Firestore integration compatibility\n\n## Status legend\n\n| Status | Meaning |\n|---|---|\n| \u2713 | **Conforming** \u2014 containerized Dart test matches platform interface under replay |\n| \u26a0 | **Diverged (documented)** \u2014 intentional difference with a written reason |\n| \u2717 | **Bug** \u2014 should match platform interface but does not |\n| \u2014 | **Not implemented yet** \u2014 explicitly outside the implemented slice |\n| ? | **Unverified** \u2014 platform interface behavior not yet verified in container |\n';

export const firestoreFlutterRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const firestoreFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'firestore-flutter',
  label: 'Firestore \u00b7 Flutter',
  compatPath: 'packages/conformance/docs/firestore-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default firestoreFlutterRegistry;
