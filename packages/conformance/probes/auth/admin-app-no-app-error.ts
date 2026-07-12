import { getApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { captureThrow } from '../../src/helpers.ts';
import type { Probe } from '../../rigs/types.ts';

/** Order matches the committed observation's `appliesTo` array. */
const ACCESSORS: Array<[string, () => unknown]> = [
  ['getDatabase', () => getDatabase()],
  ['getAuth', () => getAuth()],
  ['getFirestore', () => getFirestore()],
  ['getStorage', () => getStorage()],
  ['getApp', () => getApp()],
];

export const probe: Probe = {
  description:
    'firebase-admin accessors called with NO app while NO default app has been initialized throw FirebaseAppError code app/no-app with the [DEFAULT]-app message. Captured identically for getDatabase(), getAuth(), getFirestore(), getStorage(), and getApp(). This is the exact no-app shape to mirror. rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    const results = ACCESSORS.map(([label, fn]) => ({ label, result: captureThrow(fn) }));
    const baseline = results[0]!.result;
    // Only accessors that ACTUALLY threw the same code/message as the
    // baseline are listed — a genuine divergence surfaces as a missing entry
    // rather than being silently folded in.
    const appliesTo = results
      .filter(({ result }) => result.threw && result.code === baseline.code && result.message === baseline.message)
      .map(({ label }) => label);
    return {
      threw: baseline.threw,
      code: baseline.code,
      errorName: baseline.errorName,
      isError: baseline.isError,
      message: baseline.message,
      appliesTo,
    };
  },
};
