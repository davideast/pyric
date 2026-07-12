import { getApp, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    "firebase/app getApp() with no name resolves the default app registered by initializeApp() — the same instance, with name '[DEFAULT]'.",
  matrixRow: 'app #5',
  rowIds: ['app#5'],
  async observe() {
    const app = initializeApp(OPTS);
    const got = getApp();
    return { threw: false, resolvesSameInstance: got === app, name: got.name };
  },
};
