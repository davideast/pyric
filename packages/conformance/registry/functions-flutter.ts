import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'functions-flutter'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Cloud Functions \u00b7 Flutter Compatibility\n\nIntegration compatibility ledger for the Pure-Dart Flutter Cloud Functions callable client (`packages/flutter-client`, `pyric_functions.dart`), conforming to `cloud_functions` via the Pyric Functions HTTP gateway and WebSocket bridge.\n';

export const functionsFlutterRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const functionsFlutterRegistry: CompatibilitySurfaceRegistry = {
  surface: 'functions-flutter',
  label: 'Functions \u00b7 Flutter',
  compatPath: 'packages/conformance/docs/functions-flutter/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default functionsFlutterRegistry;
