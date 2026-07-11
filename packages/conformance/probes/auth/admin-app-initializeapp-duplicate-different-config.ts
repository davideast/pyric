import { initializeApp } from 'firebase-admin/app';
import { captureThrow } from '../../src/helpers.ts';
import type { Probe } from '../../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase-admin initializeApp(options, name) when name already exists WITH A DIFFERENT CONFIG throws FirebaseAppError code app/duplicate-app. This is the exact duplicate-app shape to mirror. rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    initializeApp({ databaseURL: 'https://a.firebaseio.com' }, 'app1');
    return captureThrow(() => initializeApp({ databaseURL: 'https://b.firebaseio.com' }, 'app1'));
  },
};
