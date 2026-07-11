import { getApp } from 'firebase-admin/app';
import { captureThrow } from './helpers.ts';
import type { Probe } from '../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase-admin getApp(name) for a name that was never initialized throws FirebaseAppError code app/no-app with a name-specific message. rowIds empty — admin-bootstrap capture; admin matrix rows land post-publish.',
  matrixRow: '',
  rowIds: [],
  async observe() {
    return captureThrow(() => getApp('does-not-exist'));
  },
};
