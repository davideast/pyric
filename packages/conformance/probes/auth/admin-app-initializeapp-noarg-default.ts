import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import type { Probe } from '../../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase-admin initializeApp() with NO args registers the default app named "[DEFAULT]". getApps() is empty before init and has length 1 after; getApp() with no arg resolves that same default instance. rowIds is intentionally empty — this is an admin-bootstrap capture and the admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    const getAppsBeforeInit = getApps().length;
    const app = initializeApp();
    const getAppsAfterInit = getApps().length;
    const resolved = getApp();
    return {
      threw: false,
      defaultAppName: app.name,
      getAppsBeforeInit,
      getAppsAfterInit,
      getAppNoArgResolvesDefault: resolved === app,
      getAppNoArgName: resolved.name,
    };
  },
};
