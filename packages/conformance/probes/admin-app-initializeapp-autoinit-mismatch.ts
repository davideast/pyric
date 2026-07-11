import { initializeApp } from 'firebase-admin/app';
import { captureThrow } from './helpers.ts';
import type { Probe } from '../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase-admin initializeApp(undefined, name) when the name already exists WITH options (autoInit state differs) throws FirebaseAppError code app/invalid-app-options. rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    initializeApp({ databaseURL: 'https://a.firebaseio.com' }, 'app1');
    return captureThrow(() => initializeApp(undefined, 'app1'));
  },
};
