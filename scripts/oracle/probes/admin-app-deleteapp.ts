import { deleteApp, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { captureThrow } from './helpers.ts';
import type { Probe } from '../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase-admin deleteApp(app) returns a Promise, removes the app from the registry (getApps() drops it), and after deletion getApp() for that name throws app/no-app; the name can be re-initialized afterward. deleteApp(nonApp) throws FirebaseAppError code app/invalid-argument. rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    const app = initializeApp();
    const ret = deleteApp(app);
    const deleteReturnsPromise = typeof (ret as unknown as { then?: unknown })?.then === 'function';
    await ret;
    const getAppsAfterDelete = getApps().length;
    const afterDelete = captureThrow(() => getApp());

    let reinitAfterDeleteThrew = false;
    try {
      initializeApp();
    } catch {
      reinitAfterDeleteThrew = true;
    }
    await deleteApp(getApp());

    // deleteApp(nonApp) — the capture is agnostic to sync-throw vs rejection;
    // a plain try/catch around an awaited call catches both.
    let deleteNonAppThrew = false;
    let deleteNonAppCode: string | undefined;
    let deleteNonAppErrorName: string | undefined;
    try {
      await deleteApp({} as unknown as App);
    } catch (e) {
      const err = e as { code?: unknown; constructor?: { name?: unknown } };
      deleteNonAppThrew = true;
      deleteNonAppCode = typeof err.code === 'string' ? err.code : undefined;
      deleteNonAppErrorName = typeof err.constructor?.name === 'string' ? err.constructor.name : undefined;
    }

    return {
      deleteReturnsPromise,
      getAppsAfterDelete,
      getAppAfterDeleteThrew: afterDelete.threw,
      getAppAfterDeleteCode: afterDelete.code,
      reinitAfterDeleteThrew,
      deleteNonAppThrew,
      deleteNonAppCode,
      deleteNonAppErrorName,
    };
  },
};
