import { initializeApp } from 'firebase/app';
import { captureThrow } from '../../src/helpers.ts';
import type { Probe } from '../../rigs/types.ts';

export const probe: Probe = {
  description:
    'firebase/app initializeApp() without options outside Firebase Hosting source deployment throws FirebaseError code app/no-options.',
  matrixRow: 'app #21',
  rowIds: ['app#21'],
  async observe() {
    return captureThrow(() => initializeApp());
  },
};
