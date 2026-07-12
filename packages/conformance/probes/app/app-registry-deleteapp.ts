import { deleteApp, getApp, getApps, initializeApp } from 'firebase/app';
import { captureThrow } from '../../src/helpers.ts';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    'firebase/app deleteApp(app) returns a Promise, deregisters the app so getApps() shrinks, and a subsequent getApp(name) throws app/no-app. The name can be re-initialized afterwards.',
  matrixRow: 'app #9',
  rowIds: ['app#9'],
  async observe() {
    const named = initializeApp(OPTS, 'secondary');
    const ret = deleteApp(named);
    const deleteReturnsPromise = Boolean(ret && typeof (ret as { then?: unknown }).then === 'function');
    await ret;
    const secondaryCountAfterDelete = getApps().filter((a) => a.name === 'secondary').length;
    const afterGet = captureThrow(() => getApp('secondary'));
    // Re-initialization after deletion succeeds (the name is free again).
    let reinitThrew = false;
    try {
      const re = initializeApp(OPTS, 'secondary');
      void re;
    } catch {
      reinitThrew = true;
    }
    return {
      deleteReturnsPromise,
      getAppsAfterDelete: secondaryCountAfterDelete,
      getAppAfterDeleteThrew: afterGet.threw,
      getAppAfterDeleteCode: afterGet.code,
      reinitAfterDeleteThrew: reinitThrew,
    };
  },
};
