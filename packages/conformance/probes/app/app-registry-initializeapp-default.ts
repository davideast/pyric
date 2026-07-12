import { getApp, getApps, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

/** Placeholder FirebaseOptions. No Firebase service is opened, so these never
 *  reach a real project — they only populate the app's `options`. */
const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    "firebase/app initializeApp(options) with no name registers the default app: app.name is '[DEFAULT]', getApps() has length 1, and getApp() (no arg) resolves the same instance. Also pins that options are preserved and automaticDataCollectionEnabled defaults to true.",
  matrixRow: 'app #1',
  rowIds: ['app#1'],
  async observe() {
    const app = initializeApp(OPTS);
    return {
      threw: false,
      name: app.name,
      getAppsLength: getApps().length,
      getAppNoArgResolvesSame: getApp() === app,
      automaticDataCollectionEnabled: app.automaticDataCollectionEnabled,
      optionKeys: Object.keys(app.options).sort(),
    };
  },
};
