import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilitySurfaceRegistry } from './types.ts';

/**
 * The `pyric/app` compatibility registry — the client app-management surface:
 * the initialization path every user hits first. Rows are authored FROM the
 * `app-registry-*` observations captured from the installed `firebase/app`
 * package (packages/conformance/observations/app/) and machine-checked by the
 * replay suite packages/pyric/test/app/oracle-conformance.test.ts.
 *
 * `initializeServerApp` is an unsupported behavior row here; its availability
 * and rationale are authored once as disposition `app.server-app` in the
 * machine-readable surface contract.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'app'));

export const appRegistry = {
  surface: 'app',
  label: 'App',
  compatPath: 'packages/pyric/docs/app/COMPAT.md',
  blocks: [
    {
      kind: 'markdown',
      markdown:
        "# `pyric/app` compatibility matrix\n\n## Status legend\n\n| Status | Meaning |\n|---|---|\n| ✓ | **Conforming** — the mirror matches prod, locked by a passing replay |\n| ⚠ | **Diverged (documented)** — intentional difference with a written reason |\n| ✗ | **Bug** — should match prod but doesn't; failing probe pins it |\n| — | **Not implemented yet** — deliberately or deferred |\n| ? | **Unverified** — claim from docs not yet observed prod-side |\n",
    },
    ...sections.blocks,
  ],
} satisfies CompatibilitySurfaceRegistry;
