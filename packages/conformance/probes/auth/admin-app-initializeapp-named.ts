import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import type { Probe } from '../../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase-admin initializeApp(options, name) registers a named app; getApp(name) resolves it and getApps() includes both the default and the named app (length 2). rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    initializeApp(); // default
    const named = initializeApp(undefined, 'secondary');
    return {
      threw: false,
      namedAppName: named.name,
      getAppByNameName: getApp('secondary').name,
      getAppsCountWithDefaultAndNamed: getApps().length,
    };
  },
};
