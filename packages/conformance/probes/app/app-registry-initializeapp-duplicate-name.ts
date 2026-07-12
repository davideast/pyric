import { initializeApp } from 'firebase/app';
import { captureThrow } from '../../src/helpers.ts';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    "firebase/app initializeApp() a second time under the same name (default '[DEFAULT]') with DIFFERENT options throws FirebaseError code app/duplicate-app, with the name embedded in the message.",
  matrixRow: 'app #3',
  rowIds: ['app#3'],
  async observe() {
    initializeApp(OPTS);
    return captureThrow(() => initializeApp({ ...OPTS, projectId: 'a-different-project' }));
  },
};
