/**
 * Completeness descriptor for the focused `rtdb-modular-*` oracle replay
 * suites beside this file. Each behavior replay lives in a concept-named
 * test file; this guard prevents a committed observation from silently
 * losing executable coverage during future splits or additions.
 */
import { describe, it, expect } from 'bun:test';
import { join } from 'node:path';
import { createObservationGate } from '../../../../../packages/conformance/src/observation-gate.ts';
import {
  NOT_APPLICABLE,
  OBS_DIR,
} from './oracle-conformance.support.js';

const obsGate = createObservationGate({
  dir: OBS_DIR,
  match: (file) => file.startsWith('rtdb-modular-'),
  notApplicable: NOT_APPLICABLE,
  siblingSources: [
    join(import.meta.dir, '..', 'on-disconnect.test.ts'),
    join(import.meta.dir, 'oracle-conformance-listeners.test.ts'),
    join(import.meta.dir, 'oracle-conformance-queries.test.ts'),
    join(import.meta.dir, 'oracle-conformance-reference-writes.test.ts'),
    join(import.meta.dir, 'oracle-conformance-runtime-identity.test.ts'),
    join(import.meta.dir, 'oracle-conformance-transactions.test.ts'),
  ],
});

describe('oracle conformance (rtdb-modular): completeness', () => {
  it('every rtdb-modular observation is covered (no silent gaps)', () => {
    const report = obsGate.report();
    expect(report.committed.length).toBe(44);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
