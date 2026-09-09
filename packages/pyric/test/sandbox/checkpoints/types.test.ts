/**
 * The checkpoint shapes and the two rules every backend enforces: what counts
 * as a name, and what counts as a checkpoint this project wrote.
 */
import { describe, it, expect } from 'bun:test';

import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_NAME_PATTERN,
  CheckpointNameError,
  assertCheckpointName,
  isCheckpointEnvelope,
} from '../../../src/sandbox/checkpoints/types.js';

/** A checkpoint-shaped value, with `overrides` applied over it. */
function envelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: CHECKPOINT_FORMAT,
    at: 1700000000000,
    counts: { firestore: 1, database: 0, storage: 0, auth: 0 },
    state: {
      firestore: {},
      database: null,
      storage: [],
      auth: { users: [], providers: {} },
      rules: { firestore: '', database: null, storage: null },
    },
    ...overrides,
  };
}

describe('a checkpoint name', () => {
  it('accepts letters, digits, dash, and underscore up to 64 characters', () => {
    for (const name of ['a', 'before-migration', 'Nightly_2', 'x'.repeat(64)]) {
      expect(() => assertCheckpointName(name)).not.toThrow();
      expect(CHECKPOINT_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it('refuses a name that could reach outside the keyspace a backend owns', () => {
    for (const name of ['', 'a/b', '../escape', 'has space', 'x'.repeat(65)]) {
      expect(() => assertCheckpointName(name)).toThrow(CheckpointNameError);
    }
  });

  it('names the rule and the offending name in the error it throws', () => {
    expect(() => assertCheckpointName('a/b')).toThrow("'a/b' is not a checkpoint name");
  });
});

describe('isCheckpointEnvelope', () => {
  it('accepts a value carrying this project\'s format, an instant, counts, and state', () => {
    expect(isCheckpointEnvelope(envelope())).toBe(true);
  });

  it('refuses a value carrying no format tag', () => {
    const untagged = envelope();
    delete (untagged as Record<string, unknown>).format;
    expect(isCheckpointEnvelope(untagged)).toBe(false);
  });

  it("refuses a value carrying another writer's format tag", () => {
    expect(isCheckpointEnvelope(envelope({ format: 'someone-elses-v9' }))).toBe(false);
  });

  it('refuses a value whose instant is not a number', () => {
    expect(isCheckpointEnvelope(envelope({ at: '2023-11-14' }))).toBe(false);
  });

  it('refuses a value missing its counts or its state', () => {
    const noCounts = envelope();
    delete (noCounts as Record<string, unknown>).counts;
    const noState = envelope();
    delete (noState as Record<string, unknown>).state;
    expect(isCheckpointEnvelope(noCounts)).toBe(false);
    expect(isCheckpointEnvelope(noState)).toBe(false);
  });

  it('refuses a value that is not an object at all', () => {
    for (const value of [null, undefined, 0, '', 'pyric-checkpoint-v1']) {
      expect(isCheckpointEnvelope(value)).toBe(false);
    }
  });
});
