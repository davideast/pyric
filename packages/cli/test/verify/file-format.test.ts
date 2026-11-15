import { describe, expect, it } from 'bun:test';
import {
  CAPTURE_RELATIVE_PATH,
  formatWrongFileError,
  identifyPyricFile,
  PREVIOUS_CAPTURE_RELATIVE_PATH,
  STATE_FIXTURE_SCHEMA,
} from '../../src/verify/file-format.js';

describe('identifyPyricFile', () => {
  it('recognizes all four versioned Pyric schemas', () => {
    expect(identifyPyricFile({ schema: 'pyric.verify.fixture.v1' })?.kind).toBe('verify-session');
    expect(identifyPyricFile({ schema: 'pyric.repro.v1' })?.kind).toBe('repro');
    expect(identifyPyricFile({ schema: 'pyric.rate-capture.v1' })?.kind).toBe('rate-capture');
    expect(identifyPyricFile({ schema: STATE_FIXTURE_SCHEMA })?.kind).toBe('state-fixture');
  });

  it('recognizes legacy unversioned sandbox state fixtures without misclassifying other objects', () => {
    expect(identifyPyricFile({ firestore: { 'items/a': { ok: true } }, users: [] })?.kind).toBe(
      'state-fixture',
    );
    expect(identifyPyricFile({ firestoreRules: '', database: { items: {} } })?.kind).toBe(
      'state-fixture',
    );
    expect(identifyPyricFile({})).toBeNull();
    expect(identifyPyricFile({ rules: '', events: [], state: {} })).toBeNull();
    expect(identifyPyricFile({ schema: 'pyric.unknown.v99', firestore: {} })).toBeNull();
    expect(identifyPyricFile({ version: 1, firestore: {} })).toBeNull();
    expect(identifyPyricFile(null)).toBeNull();
    expect(identifyPyricFile(['firestore'])).toBeNull();
  });
});

describe('formatWrongFileError', () => {
  it('names both the given file command and the expected file source on a single line', () => {
    const message = formatWrongFileError(
      'verify-session',
      { schema: STATE_FIXTURE_SCHEMA, firestore: {} },
      "fixture schema must be 'pyric.verify.fixture.v1'",
    );
    expect(message).not.toContain('\n');
    expect(message).toContain("fixture schema must be 'pyric.verify.fixture.v1'.");
    expect(message).toContain('pyric sandbox seedFromFixture');
    expect(message).toContain(CAPTURE_RELATIVE_PATH);
    expect(message).toContain(PREVIOUS_CAPTURE_RELATIVE_PATH);
  });

  it('still names the expected source when the given file is an unknown JSON shape', () => {
    const message = formatWrongFileError('repro', { hello: 'world' }, 'Not a pyric.repro.v1 file');
    expect(message).toContain('Not a pyric.repro.v1 file.');
    expect(message).toContain('pyric serve repro capture');
  });
});
