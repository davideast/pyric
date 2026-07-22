import { signInAnonymously, signOut } from 'firebase/auth';
import {
  child,
  get,
  onChildAdded,
  onChildChanged,
  onChildMoved,
  onChildRemoved,
  onValue,
  ref,
  set,
} from 'firebase/database';
import {
  adminRemove,
  cleanup,
  createClient,
  errorShape,
  repeatStable,
  scenarioPath,
  stable,
  waitFor,
} from './probe-runtime.ts';
import type { RtdbClimbContext, RtdbClimbProbe } from './probe-types.ts';

export function createProbe(ctx: RtdbClimbContext): RtdbClimbProbe {
  return {
      name: 'rtdb-modular-listener-cancellation',
      matrixRow: 'rtdb-modular#M75a',
      rowIds: ['rtdb-modular#M75a'],
      description:
        'Cancellation callback timing and Firebase error shape for initially denied and subsequently revoked value/child listeners, with successful read controls and exact rules restoration.',
      observe: () => repeatStable(2, async (attempt) => {
        const path = scenarioPath(ctx, 'listener-cancellation', attempt);
        const run = path.split('/')[1]!;
        const rulesUrl = `${ctx.config.databaseURL}/.settings/rules.json?access_token=${encodeURIComponent(ctx.rtdbAdminToken)}`;
        const readRules = async (): Promise<Record<string, unknown>> => {
          const response = await fetch(rulesUrl);
          if (!response.ok) throw new Error(`listener cancellation rules read failed: ${response.status}`);
          return response.json() as Promise<Record<string, unknown>>;
        };
        const writeRules = async (body: Record<string, unknown>): Promise<void> => {
          const response = await fetch(`${rulesUrl}&print=silent`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`listener cancellation rules write failed: ${response.status}`);
        };
        const before = await readRules();
        const rootRules = before.rules && typeof before.rules === 'object'
          ? before.rules as Record<string, unknown>
          : {};
        const oracleRules = rootRules.pyric_oracle && typeof rootRules.pyric_oracle === 'object'
          ? rootRules.pyric_oracle as Record<string, unknown>
          : {};
        const { ['.read']: _read, ['.write']: _write, ...oracleChildren } = oracleRules;
        const rulesFor = (deniedRead: boolean, revokedRead: boolean) => ({
          ...before,
          rules: {
            ...rootRules,
            pyric_oracle: {
              ...oracleChildren,
              [run]: {
                '.write': 'auth != null',
                'rtdb-climb': {
                  'listener-cancellation': {
                    [`attempt-${attempt}`]: {
                      control: { '.read': 'auth != null' },
                      denied: { '.read': deniedRead ? false : 'auth != null' },
                      revoked: { '.read': revokedRead ? false : 'auth != null' },
                      callbackless: { '.read': 'auth != null' },
                    },
                  },
                },
              },
            },
          },
        });
        const client = await createClient(ctx, `listener-cancellation-${attempt}`);
        const clientRead = (readPath: string) => fetch(
          `${ctx.config.databaseURL}/${readPath}.json?auth=${encodeURIComponent(client.authToken)}`,
        );
        const unsubs: Array<() => void> = [];
        try {
          await writeRules(rulesFor(false, false));
          await waitFor('listener cancellation allow rules readiness', async () => {
            try {
              const [control, revoked] = await Promise.all([
                clientRead(`${path}/control`),
                clientRead(`${path}/revoked`),
              ]);
              return control.ok && revoked.ok;
            } catch {
              return false;
            }
          });
          await set(ref(client.db, `${path}/control`), { ok: true });
          await set(ref(client.db, `${path}/denied`), { child: 1 });
          await set(ref(client.db, `${path}/revoked`), { child: 1 });
          await set(ref(client.db, `${path}/callbackless`), { value: 0 });
          const allowedControl = (await get(ref(client.db, `${path}/control`))).val();

          await writeRules(rulesFor(true, false));
          await waitFor('listener cancellation denied rules readiness', async () => {
            const response = await clientRead(`${path}/denied`);
            return response.status === 401 || response.status === 403;
          });
          const registrars = [onValue, onChildAdded, onChildChanged, onChildRemoved, onChildMoved] as const;
          const names = ['value', 'child_added', 'child_changed', 'child_removed', 'child_moved'] as const;
          const denied: Record<string, unknown> = {};
          for (let index = 0; index < registrars.length; index++) {
            const cancellations: Record<string, unknown>[] = [];
            let synchronous: Record<string, unknown> | null = null;
            try {
              const unsubscribe = registrars[index]!(
                ref(client.db, `${path}/denied`),
                () => undefined,
                (error: Error) => { cancellations.push(errorShape(error)); },
              ) as () => void;
              unsubs.push(unsubscribe);
            } catch (error) {
              synchronous = errorShape(error);
            }
            await waitFor(`${names[index]} initial-denial cancellation`, () =>
              synchronous !== null || cancellations.length > 0);
            denied[names[index]!] = {
              synchronous,
              cancellations,
            };
          }

          const revokedCancellations: Record<string, Record<string, unknown>[]> = {};
          const deliveryCounts: Record<string, number> = {};
          for (let index = 0; index < registrars.length; index++) {
            const name = names[index]!;
            revokedCancellations[name] = [];
            deliveryCounts[name] = 0;
            unsubs.push(registrars[index]!(
              ref(client.db, `${path}/revoked`),
              () => { deliveryCounts[name] = (deliveryCounts[name] ?? 0) + 1; },
              (error: Error) => { revokedCancellations[name]!.push(errorShape(error)); },
            ) as () => void);
          }
          await writeRules(rulesFor(true, true));
          await waitFor('revoked listener cancellations', () =>
            Object.values(revokedCancellations).every((events) => events.length === 1));
          const controlAfterRevocation = (await get(ref(client.db, `${path}/control`))).val();
          const callbacklessDeliveries: unknown[] = [];
          unsubs.push(onValue(ref(client.db, `${path}/callbackless`), (snapshot) => {
            callbacklessDeliveries.push(snapshot.val());
          }));
          await waitFor('callbackless listener initial readiness', () =>
            callbacklessDeliveries.length === 1);
          await signOut(client.auth);
          const signedOutCancellations: Record<string, unknown>[] = [];
          unsubs.push(onValue(
            ref(client.db, `${path}/callbackless`),
            () => undefined,
            (error) => { signedOutCancellations.push(errorShape(error)); },
          ));
          await waitFor('callbackless listener signed-out denial readiness', () =>
            signedOutCancellations.length === 1);
          await signInAnonymously(client.auth);
          const freshControlDeliveries: unknown[] = [];
          unsubs.push(onValue(ref(client.db, `${path}/callbackless`), (snapshot) => {
            freshControlDeliveries.push(snapshot.val());
          }));
          await set(ref(client.db, `${path}/callbackless`), { value: 1 });
          await waitFor('callbackless fresh-listener control delivery', () =>
            (freshControlDeliveries.at(-1) as { value?: number } | undefined)?.value === 1);
          return {
            allowedControl,
            denied,
            revoked: { deliveryCounts, cancellations: revokedCancellations },
            controlAfterRevocation,
            callbacklessAuth: {
              deliveries: callbacklessDeliveries,
              signedOutCancellations,
              freshControlDeliveries,
            },
          };
        } finally {
          for (const unsubscribe of unsubs) unsubscribe();
          await cleanup([
            () => client.close(),
            () => adminRemove(ctx, path),
            async () => {
              await writeRules(before);
              if (stable(await readRules()) !== stable(before)) {
                throw new Error('listener cancellation rules restore verification failed');
              }
            },
          ]);
        }
      }),
    };
}
