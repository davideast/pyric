import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRegistrySections } from './load-section-rows.ts';
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from './types.ts';

/**
 * Messaging compatibility registry — the first surface authored under
 * Conformance Driven Development (CDD; see `docs/conformance/cdd.md`).
 *
 * ROW UNIVERSE. Every row below is signed off by
 * `packages/conformance/docs/messaging/surface-inventory.md` (wayfinder #44), the v1
 * shape universe enumerated from the installed `firebase@12.13.0`
 * (`@firebase/messaging@0.12.26`, client + service-worker planes) and
 * `firebase-admin@13.10.0` (send plane) typings. Instance-method and
 * option-field completeness closes later with the tier-2 assignability census
 * (resolved decision #5); rows here are authored at export / method / named-type
 * granularity, not one row per option field.
 *
 * TWO SURFACES, ONE DOC. Client + service-worker rows carry surface
 * `'messaging'`; admin send-plane rows carry surface `'messaging-admin'`. Both
 * share this one registry file and one generated `COMPAT.md`, on the
 * `rtdb` / `rtdb-modular` precedent (resolved decision #4). Per-surface
 * conformance-suite paths live on the descriptors in `index.ts`.
 *
 * BORN UNVERIFIED, FLIPPED ON REVIEW. Every row was authored
 * `status: 'unverified'`, `automation: 'unverified'` before the mirrors
 * existed. A row flips to `conforms` (via the seed's `flipped` tier) only when
 * its assertion set in the surface's conformance suite passes unweakened, and
 * both suites run un-gated in their packages' blocking test path. Rows that
 * replay cited `messaging-*` observation values are `oracle-backed`; export,
 * shape, and module-boundary witnesses are `unit-backed` and KEEP their climb
 * risk (`unobserved` / `cited-not-replayed`) — flipping proves the assertion
 * set passes, not that production behavior was observed. A future row added
 * without `flipped` is born unverified and carries a riskReason until its
 * assertion set lands and passes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const sections = loadRegistrySections(join(HERE, 'messaging'), {
  ignoreFiles: new Set(['defaults.ts']),
});

const INTRO = [
  '# `pyric` messaging compatibility matrix',
  '',
  '## Status legend',
  '',
  '| Status | Meaning |',
  '|---|---|',
  '| ✓ | **Conforming** — sandbox matches prod, locked by a passing probe |',
  '| ⚠ | **Diverged (documented)** — intentional difference with a written reason |',
  '| ✗ | **Bug** — should match prod but doesn\'t; failing probe pins it |',
  '| — | **Not implemented yet** — deliberately or pending |',
  '| ? | **Unverified** — a target with a derived failing test, not a guarantee |',
].join('\n');

export const messagingRegistry: CompatibilitySurfaceRegistry = {
  surface: 'messaging',
  label: 'Messaging',
  compatPath: 'packages/pyric/docs/messaging/COMPAT.md',
  blocks: [
    { kind: 'markdown', markdown: INTRO + '\n' },
    ...sections.blocks,
  ],
};

/** All messaging rows in doc order (client + sw + admin). */
export const messagingRows: CompatibilityRow[] = sections.blocks.flatMap((block) => block.rows);
