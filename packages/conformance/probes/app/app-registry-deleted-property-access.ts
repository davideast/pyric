import { deleteApp, initializeApp } from 'firebase/app';
import type { Probe } from '../../rigs/types.ts';

const OPTS = { apiKey: 'fake-api-key', projectId: 'demo-app-registry', appId: '1:0:web:0' };

function observeAccess(read: () => unknown): Record<string, unknown> {
  try {
    read();
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
}

export const probe: Probe = {
  description:
    'After firebase/app deleteApp(app) resolves, reading name, options, or automaticDataCollectionEnabled from the deleted app throws FirebaseError code app/app-deleted.',
  matrixRow: 'app #24',
  rowIds: ['app#24'],
  async observe() {
    const app = initializeApp(OPTS, 'secondary');
    await deleteApp(app);
    return {
      name: observeAccess(() => app.name),
      options: observeAccess(() => app.options),
      automaticDataCollectionEnabled: observeAccess(() => app.automaticDataCollectionEnabled),
    };
  },
};
