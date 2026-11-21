import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'crashlytics'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO =
  '# Firebase Crashlytics \u00b7 Web Compatibility\n\nIntegration compatibility ledger for `pyric/crashlytics`, conforming to `@firebase/crashlytics` (`firebase/crashlytics` public preview) via `CrashlyticsBroker` and the served SharedWorker / `HostedRuntime` bridge.\n';

export const crashlyticsRows: CompatibilityRow[] = sections.blocks.flatMap(
  (block) => block.rows,
);

export const crashlyticsRegistry: CompatibilitySurfaceRegistry = {
  surface: 'crashlytics',
  label: 'Crashlytics',
  compatPath: 'packages/conformance/docs/crashlytics/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO },
    ...sections.blocks,
  ],
};

export default crashlyticsRegistry;
