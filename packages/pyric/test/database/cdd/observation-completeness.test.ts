import { describe, expect, it } from 'bun:test';
import { allCompatibilityRows } from '../../../../conformance/registry/index.ts';
import { loadObservations } from '../../../../conformance/observations/load.ts';
import {
  auditObservationCompleteness,
  discoverCddAssertionRowIds,
  type ObservationCompletenessInput,
} from './observation-completeness.js';

const NOT_APPLICABLE: Readonly<Record<string, string>> = {};

describe('rtdb-modular CDD observation completeness', () => {
  it('fails closed when a committed observation has no joined CDD row', () => {
    const input: ObservationCompletenessInput = {
      observations: [{ name: 'rtdb-modular-new-capture', rowIds: ['rtdb-modular#999'] }],
      rows: [],
      assertedRowIds: [],
      notApplicable: {},
    };

    expect(auditObservationCompleteness(input).uncovered).toEqual([
      'rtdb-modular-new-capture',
    ]);
  });

  it('requires explicit NOT_APPLICABLE entries to name a capture and explain why', () => {
    const input: ObservationCompletenessInput = {
      observations: [{ name: 'rtdb-modular-covered', rowIds: [] }],
      rows: [],
      assertedRowIds: [],
      notApplicable: {
        'rtdb-modular-covered': '   ',
        'rtdb-modular-missing': 'not in the committed corpus',
      },
    };

    expect(auditObservationCompleteness(input).invalidNotApplicable).toEqual([
      'rtdb-modular-covered: reason is empty',
      'rtdb-modular-missing: no committed observation',
    ]);
  });

  it('joins every committed observation to a row-keyed CDD assertion or an explicit reason', () => {
    const result = auditObservationCompleteness({
      observations: loadObservations().filter(({ surfaceDir }) => surfaceDir === 'rtdb-modular'),
      rows: allCompatibilityRows.filter(({ surface }) => surface === 'rtdb-modular'),
      assertedRowIds: discoverCddAssertionRowIds(import.meta.dir),
      notApplicable: NOT_APPLICABLE,
    });

    expect(result).toEqual({
      uncovered: [],
      duplicateAssertions: [],
      invalidNotApplicable: [],
      staleCitations: [],
      unassertedRows: [],
      unknownAssertions: [],
    });
  });
});
