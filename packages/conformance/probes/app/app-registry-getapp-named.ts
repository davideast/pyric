import { getApp, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    "firebase/app getApp('secondary') resolves the named app registered under that name — the same instance, with name 'secondary'.",
  matrixRow: 'app #6',
  rowIds: ['app#6'],
  async observe() {
    initializeApp(OPTS);
    const named = initializeApp(OPTS, 'secondary');
    const got = getApp('secondary');
    return { threw: false, resolvesSameInstance: got === named, name: got.name };
  },
};
