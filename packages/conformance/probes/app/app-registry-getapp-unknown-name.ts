import { getApp } from 'firebase/app';
import { captureThrow } from '../../src/helpers.ts';
import type { Probe } from '../../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase/app getApp(name) for a name that was never initialized (empty registry) throws FirebaseError code app/no-app with a name-specific message directing the caller to initializeApp().',
  matrixRow: 'app #7',
  rowIds: ['app#7'],
  async observe() {
    return captureThrow(() => getApp('does-not-exist'));
  },
};
