import { describe, expect, it } from 'bun:test';
import {
  CAPTURE_RELATIVE_PATH,
  countDeniedEvents,
  formatCaptureEventCounts,
  formatWrongFileError,
  identifyPyricFile,
  PREVIOUS_CAPTURE_RELATIVE_PATH,
  STATE_FIXTURE_SCHEMA,
} from '../../src/verify/file-format.js';

describe('identifyPyricFile and formatWrongFileError', () => {
  it('identifies all four versioned Pyric formats and legacy unversioned state fixtures', () => {
    expect(identifyPyricFile({ schema: 'pyric.verify.fixture.v1', events: [] })?.kind).toBe('verify-session');
    expect(identifyPyricFile({ schema: 'pyric.repro.v1', entries: [] })?.kind).toBe('repro');
    expect(identifyPyricFile({ schema: 'pyric.rate-capture.v1' })?.kind).toBe('rate-capture');
    expect(identifyPyricFile({ schema: STATE_FIXTURE_SCHEMA, firestore: {} })?.kind).toBe('state-fixture');
    expect(identifyPyricFile({ firestore: { 'items/1': { ok: true } } })?.kind).toBe('state-fixture');
  });

  it('returns null for unknown schemas, empty objects, versioned state files, and primitives', () => {
    expect(identifyPyricFile(null)).toBeNull();
    expect(identifyPyricFile([])).toBeNull();
    expect(identifyPyricFile({})).toBeNull();
    expect(identifyPyricFile({ version: 1, firestore: {} })).toBeNull();
    expect(identifyPyricFile({ schema: 'pyric.unknown.v99' })).toBeNull();
    expect(identifyPyricFile({ firestore: {}, unrelated: 1 })).toBeNull();
  });

  it('produces single-line actionable messages naming both given and expected formats', () => {
    const message = formatWrongFileError(
      'verify-session',
      { schema: STATE_FIXTURE_SCHEMA, firestore: {} },
      'Invalid fixture',
    );
    expect(message).not.toContain('\n');
    expect(message).toContain('sandbox state fixture');
    expect(message).toContain('pyric sandbox seedFromFixture');
    expect(message).toContain(CAPTURE_RELATIVE_PATH);
    expect(message).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);

    const customConsumer = formatWrongFileError(
      'verify-session',
      { schema: 'pyric.repro.v1' },
      'No recorded session was read',
      'pyric sandbox apply',
    );
    expect(customConsumer).toContain('pyric serve repro replay');
    expect(customConsumer).toContain('pyric sandbox apply expects');
  });

  it('counts denied events and formats singular/plural capture counts', () => {
    expect(countDeniedEvents([{ result: 'allow' }, { result: 'deny' }, {}])).toBe(1);
    expect(formatCaptureEventCounts(1, 1)).toBe('1 event, 1 denial');
    expect(formatCaptureEventCounts(4, 0)).toBe('4 events, 0 denials');
  });
});
