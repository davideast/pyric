import { describe, expect, it } from 'bun:test';
import { FirebaseError as UpstreamFirebaseError } from 'firebase/app';
import { FieldPath as UpstreamFieldPath } from 'firebase/firestore';
import { FirebaseError } from 'pyric/app';
import { FieldPath, FirestoreError } from 'pyric/firestore';

describe('FieldPath invalid-argument validation (#1973)', () => {
  it('throws FirebaseError(invalid-argument) instead of TypeError on empty or missing segments', () => {
    let upEmptySegmentErr: unknown;
    let pyEmptySegmentErr: unknown;
    try {
      new UpstreamFieldPath('a', '');
    } catch (error) {
      upEmptySegmentErr = error;
    }
    try {
      new FieldPath('a', '');
    } catch (error) {
      pyEmptySegmentErr = error;
    }
    expect(upEmptySegmentErr).toBeInstanceOf(UpstreamFirebaseError);
    expect(pyEmptySegmentErr).toBeInstanceOf(FirebaseError);
    expect(pyEmptySegmentErr).not.toBeInstanceOf(TypeError);
    expect(pyEmptySegmentErr).not.toBeInstanceOf(FirestoreError);
    expect((pyEmptySegmentErr as FirebaseError).code).toBe('invalid-argument');

    let noArgsErr: unknown;
    try {
      new FieldPath();
    } catch (error) {
      noArgsErr = error;
    }
    expect(noArgsErr).toBeInstanceOf(FirebaseError);
    expect(noArgsErr).not.toBeInstanceOf(TypeError);
    expect((noArgsErr as FirebaseError).code).toBe('invalid-argument');

    const valid = new FieldPath('profile', 'display.name');
    expect(valid.isEqual(new FieldPath('profile', 'display.name'))).toBe(true);
  });
});
