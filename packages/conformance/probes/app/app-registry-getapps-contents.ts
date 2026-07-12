import { getApps, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    'firebase/app getApps() returns an array of every registered app by identity — it contains the exact default and named instances returned by initializeApp (not copies).',
  matrixRow: 'app #8',
  rowIds: ['app#8'],
  async observe() {
    const defaultApp = initializeApp(OPTS);
    const named = initializeApp(OPTS, 'secondary');
    const apps = getApps();
    return {
      isArray: Array.isArray(apps),
      length: apps.length,
      includesDefault: apps.includes(defaultApp),
      includesNamed: apps.includes(named),
    };
  },
};
