import { type App, type Credential, deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { Probe } from '../../rigs/types.ts';

interface DeletedAppCallOutcome {
  mode: 'sync-throw' | 'rejected' | 'resolved';
  code: string | null;
  message: string | null;
}

interface GetAuthAppLifecycleBehavior {
  authAppMatchesExplicitApp: boolean;
  cachedSameAppHandle: boolean;
  distinctHandlesAcrossApps: boolean;
  getAuthAfterDeleteApp: DeletedAppCallOutcome;
}

const INERT_CREDENTIAL: Credential = {
  getAccessToken: async () => ({
    access_token: '',
    expires_in: 0,
  }),
};

function captureSyncGetAuthOutcome(
  operation: () => unknown,
  appName: string,
): DeletedAppCallOutcome {
  try {
    operation();
    return {
      mode: 'resolved',
      code: null,
      message: null,
    };
  } catch (error) {
    const shaped = error as { code?: unknown; message?: unknown };
    let code: string | null = null;
    if (typeof shaped.code === 'string') {
      code = shaped.code;
    }
    let message = String(error);
    if (typeof shaped.message === 'string') {
      message = shaped.message;
    }
    message = message.replaceAll(appName, '<appName>');
    return {
      mode: 'sync-throw',
      code,
      message,
    };
  }
}

export async function observeGetAuthAppLifecycle(): Promise<GetAuthAppLifecycleBehavior> {
  const createdApps: App[] = [];
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const appAName = `admin-auth-lifecycle-a-${runSuffix}`;
  const appBName = `admin-auth-lifecycle-b-${runSuffix}`;

  const appA = initializeApp(
    { credential: INERT_CREDENTIAL, projectId: 'demo-project' },
    appAName,
  );
  const appB = initializeApp(
    { credential: INERT_CREDENTIAL, projectId: 'demo-project' },
    appBName,
  );
  createdApps.push(appB);

  try {
    const firstHandle = getAuth(appA);
    const secondHandle = getAuth(appA);
    const otherAppHandle = getAuth(appB);

    const authAppMatchesExplicitApp = firstHandle.app === appA;
    const cachedSameAppHandle = firstHandle === secondHandle;
    const distinctHandlesAcrossApps = firstHandle !== otherAppHandle;

    await deleteApp(appA);
    const getAuthAfterDeleteApp = captureSyncGetAuthOutcome(() => getAuth(appA), appAName);

    return {
      authAppMatchesExplicitApp,
      cachedSameAppHandle,
      distinctHandlesAcrossApps,
      getAuthAfterDeleteApp,
    };
  } finally {
    await Promise.all(createdApps.map((app) => deleteApp(app).catch(() => undefined)));
  }
}

export const probe: Probe = {
  rig: 'admin-auth',
  requires: ['admin-auth'],
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/auth getAuth(app) handle routing, per-app handle caching (getAuth(app) === getAuth(app)), cross-app handle isolation, and synchronous app/app-deleted rejection after deleteApp(app).',
  async observe() {
    const observed = await observeGetAuthAppLifecycle();
    return { ...observed };
  },
};
