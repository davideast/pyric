import { deleteApp, getApp, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    'firebase/app releases a deleted app name and permits that name to be initialized with different FirebaseOptions afterwards.',
  matrixRow: 'app #20',
  rowIds: ['app#20'],
  async observe() {
    const first = initializeApp(OPTS);
    await deleteApp(first);
    const second = initializeApp(
      { ...OPTS, projectId: 'other-app-registry', appId: '1:1:web:1' },
    );
    return {
      threw: false,
      distinctApps: first !== second,
      lookupSame: getApp() === second,
      projectId: second.options.projectId,
    };
  },
};
