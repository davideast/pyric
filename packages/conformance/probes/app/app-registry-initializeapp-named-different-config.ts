import { getApp, getApps, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    'firebase/app permits a differently configured app under a different name and retains each app\'s independent backend-selecting options.',
  matrixRow: 'app #19',
  rowIds: ['app#19'],
  async observe() {
    const first = initializeApp(OPTS);
    const second = initializeApp(
      { ...OPTS, projectId: 'other-app-registry', appId: '1:1:web:1' },
      'secondary',
    );
    return {
      threw: false,
      distinctApps: first !== second,
      getAppsLength: getApps().length,
      namedLookupSame: getApp('secondary') === second,
      projectIds: [first.options.projectId, second.options.projectId],
    };
  },
};
