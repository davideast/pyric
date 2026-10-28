import { deleteApp, initializeApp } from 'firebase/app';
import { getDatabase, goOffline, type Database } from 'firebase/database';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

/**
 * Database URL forms `getDatabase(app, url)` receives. Each one runs in a fresh
 * app so the SDK's per-app repo cache cannot reject a later form of the same
 * URL. The handle goes offline before it connects; the probe writes nothing.
 */
export const DATABASE_URL_INPUTS = [
  'https://my-instance.firebaseio.com',
  'https://my-instance.firebaseio.com/',
  'HTTPS://MY-INSTANCE.FIREBASEIO.COM/',
  'my-instance.firebaseio.com',
  'wss://my-instance.firebaseio.com',
  'https://my-instance.firebaseio.com:443',
  'https://my-instance.firebaseio-demo.com',
  'https://my-instance.europe-west1.firebasedatabase.app',
  'https://My-Instance.Europe-West1.Firebasedatabase.App/',
  'https://my-instance.asia-southeast1.firebasedatabase.app',
  'http://localhost:9000?ns=db1',
  'http://localhost:9000/?ns=DB1',
  'http://localhost:9000?NS=db1',
  'http://localhost:9000',
  'http://127.0.0.1:9000?ns=db1',
  'https://proxy.example.com?ns=db1',
  'https://my-instance.firebaseio.com?ns=other',
  'my-instance',
  'default',
  'https://example.com',
  'https://my-instance.firebaseio.com?ns=',
  'https://firebase.com',
  'https://x.firebase.com',
  'https://my-instance.firebaseio.com/users',
  'https://my-instance.firebaseio.com/.info',
  'https://my-instance.firebaseio.com/a.b',
  'https://bad#name.firebaseio.com',
  'https://my-instance.firebaseio.com?ns=a.b',
] as const;

interface RepoInfoView {
  namespace: string;
  toURLString(): string;
}

function repoInfo(db: Database): RepoInfoView {
  return (db as unknown as { _repo: { repoInfo_: RepoInfoView } })._repo.repoInfo_;
}

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
    name: 'rtdb-modular-database-url-instance',
    matrixRow: 'rtdb-modular#M39',
    rowIds: ['rtdb-modular#M39'],
    description:
      'getDatabase(app, url) for each database URL form: the instance name (namespace) and root URL the SDK derives, or the Error message it throws; plus the default instance for an app with only a project id.',
    async observe() {
      const urls: Record<string, { name: string; url: string } | { error: string; errorClass: string }> = {};
      let index = 0;
      for (const input of DATABASE_URL_INPUTS) {
        const app = initializeApp(ctx.config, `database-url-instance-${ctx.runId}-${index++}`);
        try {
          const db = getDatabase(app, input);
          goOffline(db);
          urls[input] = { name: repoInfo(db).namespace, url: repoInfo(db).toURLString() };
        } catch (error) {
          urls[input] = {
            error: error instanceof Error ? error.message : String(error),
            errorClass: error instanceof Error ? error.constructor.name : typeof error,
          };
        } finally {
          await deleteApp(app);
        }
      }

      const { databaseURL: _databaseURL, ...projectOnly } = ctx.config;
      const defaultApp = initializeApp(projectOnly, `database-url-instance-${ctx.runId}-default`);
      let projectDefault: { name: string; url: string };
      try {
        const db = getDatabase(defaultApp);
        goOffline(db);
        projectDefault = { name: repoInfo(db).namespace, url: repoInfo(db).toURLString() };
      } finally {
        await deleteApp(defaultApp);
      }
      return {
        urls,
        projectDefault: {
          ...projectDefault,
          nameIsProjectIdDefaultRtdb: projectDefault.name === `${ctx.config.projectId}-default-rtdb`,
        },
      };
    },
  };
}
