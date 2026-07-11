import { initializeApp } from 'firebase-admin/app';
import { captureThrow } from './helpers.ts';
import type { Probe } from '../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase-admin initializeApp(options, name) with an empty-string (or non-string) app name throws FirebaseAppError code app/invalid-app-name. rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    return captureThrow(() => initializeApp(undefined, ''));
  },
};
