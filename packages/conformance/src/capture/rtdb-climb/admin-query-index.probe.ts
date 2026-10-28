import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getDatabaseWithUrl } from 'firebase-admin/database';
import { adminRemove, cleanup, repeatStable, scenarioPath } from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

/** Strip the logger timestamp and the run-scoped path so repeated attempts compare equal. */
function normalize(text: string, base: string): string {
  return text.replace(/^\[[^\]]*\]\s*/, '').split(`/${base}`).join('/<base>').split(base).join('<base>');
}

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
    name: 'rtdb-modular-admin-query-index',
    matrixRow: 'rtdb-modular#144',
    rowIds: ['rtdb-modular#144'],
    description:
      'The Admin SDK, which bypasses rules, against an orderByChild query at a location with no `.indexOn`: get() limited and unlimited, and once(\'value\') limited, recording rejections, delivered keys and client log warnings.',
    observe: () => repeatStable(2, async (attempt) => {
      const path = scenarioPath(ctx, 'admin-query-index', attempt);
      const app = initializeApp({
        credential: {
          getAccessToken: async () => ({ access_token: ctx.rtdbAdminToken, expires_in: 3600 }),
        },
        databaseURL: ctx.config.databaseURL,
      }, `rtdb-climb-admin-query-index-${ctx.runId}-${attempt}`);
      const db = getDatabaseWithUrl(ctx.config.databaseURL, app);
      const logs: string[] = [];
      const sinks = { warn: console.warn, log: console.log, error: console.error };
      const capture = (sink: (...args: unknown[]) => void, level: string) => (...args: unknown[]) => {
        const text = args.map(String).join(' ');
        if (text.includes('@firebase/database')) logs.push(`${level}: ${normalize(text, path)}`);
        else sink(...args);
      };
      try {
        await db.ref(path).set({ a: { pos: 3 }, b: { pos: 1 }, c: { pos: 2 } });
        console.warn = capture(sinks.warn, 'warn');
        console.log = capture(sinks.log, 'log');
        console.error = capture(sinks.error, 'error');
        const outcome = async (run: () => Promise<{ forEach(cb: (child: { key: string | null }) => void): unknown }>) => {
          try {
            const snap = await run();
            const keys: Array<string | null> = [];
            snap.forEach((child) => { keys.push(child.key); });
            return { resolved: true, keys };
          } catch (error) {
            return {
              resolved: false,
              code: (error as { code?: unknown }).code ?? null,
              message: normalize((error as Error).message, path),
            };
          }
        };
        const query = () => db.ref(path).orderByChild('pos');
        return {
          getLimited: await outcome(() => query().limitToFirst(2).get()),
          getUnlimited: await outcome(() => query().get()),
          onceLimited: await outcome(() => query().limitToFirst(2).once('value')),
          logs,
        };
      } finally {
        Object.assign(console, sinks);
        await cleanup([() => adminRemove(ctx, path), () => deleteApp(app)]);
      }
    }),
  };
}
