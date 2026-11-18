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

export interface GetAuthAppLifecycleSubject<
  AppHandle,
  AuthHandle extends { readonly app: AppHandle },
> {
  initializeNamedApp(name: string): AppHandle;
  getAuth(app: AppHandle): AuthHandle;
  deleteApp(app: AppHandle): Promise<void>;
}

export async function observeGetAuthAppLifecycleFor<
  AppHandle,
  AuthHandle extends { readonly app: AppHandle },
>(subject: GetAuthAppLifecycleSubject<AppHandle, AuthHandle>): Promise<GetAuthAppLifecycleBehavior> {
  const createdApps: AppHandle[] = [];
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const appAName = `admin-auth-lifecycle-a-${runSuffix}`;
  const appBName = `admin-auth-lifecycle-b-${runSuffix}`;

  const appA = subject.initializeNamedApp(appAName);
  const appB = subject.initializeNamedApp(appBName);
  createdApps.push(appB);

  try {
    const firstHandle = subject.getAuth(appA);
    const secondHandle = subject.getAuth(appA);
    const otherAppHandle = subject.getAuth(appB);

    const authAppMatchesExplicitApp = firstHandle.app === appA;
    const cachedSameAppHandle = firstHandle === secondHandle;
    const distinctHandlesAcrossApps = firstHandle !== otherAppHandle;

    await subject.deleteApp(appA);
    const getAuthAfterDeleteApp = captureSyncGetAuthOutcome(
      () => subject.getAuth(appA),
      appAName,
    );

    return {
      authAppMatchesExplicitApp,
      cachedSameAppHandle,
      distinctHandlesAcrossApps,
      getAuthAfterDeleteApp,
    };
  } finally {
    await Promise.all(
      createdApps.map((app) => subject.deleteApp(app).catch(() => undefined)),
    );
  }
}

export async function observeGetAuthAppLifecycle(): Promise<GetAuthAppLifecycleBehavior> {
  return observeGetAuthAppLifecycleFor({
    initializeNamedApp(name: string): App {
      return initializeApp({ credential: INERT_CREDENTIAL, projectId: 'demo-project' }, name);
    },
    getAuth(app: App) {
      return getAuth(app);
    },
    deleteApp(app: App): Promise<void> {
      return deleteApp(app);
    },
  });
}

export const probe: Probe = {
  rig: 'admin-auth',
  requires: ['admin-auth'],
  matrixRow: 'auth-admin#1a',
  rowIds: ['auth-admin#1a'],
  description:
    'firebase-admin/auth getAuth(app) handle routing, per-app handle caching (getAuth(app) === getAuth(app)), cross-app handle isolation, and synchronous app/app-deleted rejection after deleteApp(app).',
  async observe() {
    const observed = await observeGetAuthAppLifecycle();
    return { ...observed };
  },
};
