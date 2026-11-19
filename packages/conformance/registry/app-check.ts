import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_CHECK_SUITES } from './app-check/defaults.ts';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

/**
 * The App Check registry, climbing under Conformance Driven Development
 * (docs/conformance/cdd.md). Two surface planes share it, on the messaging
 * precedent: `app-check` (the web SDK, `pyric/app-check`) and
 * `app-check-admin` (firebase-admin, `pyric-admin/app-check`).
 *
 * Rows come from two inputs. The census (`compat:census`, surface
 * `app-check`) gives the shape universe: the 8 runtime exports of
 * `firebase/app-check` 12.13.0. The 18 `app-check-` captures
 * (packages/conformance/docs/app-check/capture-plan.md) give the behavior
 * facts. A row's behavior states a production fact only where a cited capture
 * vouches for it; anything else is marked upstream-documented in `evidence`
 * and carries an `unobserved` risk.
 *
 * Rows about production AI pass-through (the real `firebase/app-check` on the
 * bridged app so `firebase/ai` sends `X-Firebase-AppCheck`) live in the `ai`
 * registry beside the AI rows, and cite these captures from there.
 *
 * Each row's assertion set is in its plane's red suite (APP_CHECK_SUITES). A
 * row flips only when that assertion set passes unweakened.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'app-check'), {
  ignoreFiles: new Set(['defaults.ts']),
});

export { APP_CHECK_SUITES };

export const appCheckRows: CompatibilityRow[] = [
  ...sections.rowsOf('init'),
  ...sections.rowsOf('tokens'),
  ...sections.rowsOf('listeners'),
  ...sections.rowsOf('wire'),
  ...sections.rowsOf('admin'),
];

export const appCheckRegistry: CompatibilitySurfaceRegistry = {
  surface: 'app-check',
  label: 'App Check',
  compatPath: 'packages/pyric/docs/app-check/COMPAT.md',
  blocks: [
    {
      kind: 'markdown',
      markdown:
        '# App Check compatibility\n\nApp Check is climbing under Conformance Driven Development. A row below is a target with a derived assertion set, not a guarantee, until its status says otherwise. Production AI pass-through rows live in the AI Logic compatibility page.\n',
    },
    ...sections.blocks,
  ],
};
