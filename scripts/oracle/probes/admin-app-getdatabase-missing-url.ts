import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { captureThrow } from './helpers.ts';
import type { Probe } from '../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase-admin getDatabase() resolves the default app but throws when the app has no databaseURL configured: FirebaseError code database/invalid-argument, message "Can\'t determine Firebase Database URL.". Providing a databaseURL on the app lets getDatabase(app) return a Database. This is a prod-specific requirement the pyric-admin sandbox does NOT model (the sandbox has no notion of a databaseURL), so it is N/A for sandbox conformance. rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    const app = initializeApp();
    const missing = captureThrow(() => getDatabase());
    await deleteApp(app);

    // A fake, unreachable hostname is enough: getDatabase() only constructs a
    // Repo handle here (constructor name is what this probe measures) — the
    // actual socket connection is opened lazily on first `.ref()`/listener
    // use, which this probe never touches, so no network call happens.
    const withUrlApp = initializeApp(
      { databaseURL: 'https://oracle-probe-default-rtdb.firebaseio.com' },
      'admin-app-getdatabase-missing-url',
    );
    let withDatabaseUrlReturnsConstructor: string | undefined;
    try {
      withDatabaseUrlReturnsConstructor = getDatabase(withUrlApp).constructor.name;
    } finally {
      await deleteApp(withUrlApp);
    }

    return {
      threw: missing.threw,
      code: missing.code,
      errorName: missing.errorName,
      isError: missing.isError,
      message: missing.message,
      withDatabaseUrlReturnsConstructor,
    };
  },
};
