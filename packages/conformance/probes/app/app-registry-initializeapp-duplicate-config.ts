import { getApps, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    'firebase/app initializeApp() a second time under the same name with EQUAL options is idempotent: it does not throw and returns the SAME app instance; getApps() stays length 1.',
  matrixRow: 'app #4',
  rowIds: ['app#4'],
  async observe() {
    const first = initializeApp(OPTS);
    const second = initializeApp(OPTS);
    return {
      threw: false,
      returnedSameInstance: first === second,
      getAppsLength: getApps().length,
    };
  },
};
