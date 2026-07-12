import { getApp, getApps, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    "firebase/app initializeApp(options, 'secondary') registers a named app alongside the default: named.name is 'secondary', getApp('secondary') resolves the same instance, and getApps() has length 2 (default + named).",
  matrixRow: 'app #2',
  rowIds: ['app#2'],
  async observe() {
    const defaultApp = initializeApp(OPTS);
    const named = initializeApp(OPTS, 'secondary');
    return {
      threw: false,
      defaultName: defaultApp.name,
      namedName: named.name,
      getAppsLength: getApps().length,
      getAppByNameResolvesSame: getApp('secondary') === named,
    };
  },
};
