import { deleteApp, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

export const probe: Probe = {
  description:
    'firebase/app deleteApp(app) called a second time on an already-deleted app throws FirebaseError code app/app-deleted with the name embedded in the message. The try/catch catches both a synchronous throw and a rejected promise.',
  matrixRow: 'app #10',
  rowIds: ['app#10'],
  async observe() {
    const named = initializeApp(OPTS, 'secondary');
    await deleteApp(named);
    try {
      await deleteApp(named);
      return { threw: false };
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown; constructor?: { name?: unknown } };
      return {
        threw: true,
        code: typeof err.code === 'string' ? err.code : undefined,
        errorName: typeof err.constructor?.name === 'string' ? err.constructor.name : undefined,
        isError: e instanceof Error,
        message: typeof err.message === 'string' ? err.message : undefined,
      };
    }
  },
};
