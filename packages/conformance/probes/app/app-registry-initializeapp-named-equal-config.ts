import { getApp, getApps, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    'firebase/app permits default and named apps with deep-equal FirebaseOptions: the app containers are distinct, retain equal option values, and remain independently addressable by name.',
  matrixRow: 'app #17',
  rowIds: ['app#17'],
  async observe() {
    const defaultApp = initializeApp(OPTS);
    const namedApp = initializeApp({ ...OPTS }, 'secondary');
    return {
      distinctApps: defaultApp !== namedApp,
      equalOptions: JSON.stringify(defaultApp.options) === JSON.stringify(namedApp.options),
      defaultLookupSame: getApp() === defaultApp,
      namedLookupSame: getApp('secondary') === namedApp,
      appNames: getApps().map((app) => app.name),
    };
  },
};
