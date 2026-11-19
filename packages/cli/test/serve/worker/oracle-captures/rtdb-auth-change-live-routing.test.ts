import { describe, expect, it } from 'bun:test';
import * as client from '../../../../src/serve/worker/index.js';
import {
  AUTH_CHANGE_LIVE_ROUTING_RUN_RULES,
  observeAuthChangeLiveRouting,
  withDeniedGetCode,
  type AuthChangeLiveRoutingObservation,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-auth-change-live-routing.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

type AuthChangePlaneFactory = (
  databaseRules: Record<string, unknown>,
) => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, AuthChangePlaneFactory]> = [
  ['served SharedWorker', (databaseRules) => servedRtdbContext(databaseRules)],
  ['served Node host', (databaseRules) => hostedRtdbContext(databaseRules)],
];

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB live auth-change routing oracle capture (${planeLabel})`, () => {
    it('rtdb-modular-auth-change-live-routing (rtdb-modular#M38)', async () => {
      const observed = load(
        'rtdb-modular-auth-change-live-routing',
      ) as unknown as AuthChangeLiveRoutingObservation;

      expect(observed.initialSignedOut.readAuthed.code).toBeNull();
      expect(observed.afterSwitchToBob.readAliceOther.code).toBeNull();
      expect(observed.afterSignOut.readAuthedDenied.code).toBeNull();

      const runId = 'served_auth_change_replay';
      const basePath = `/pyric_oracle/${runId}`;
      const aliceUid = 'served-alice-uid';
      const bobUid = 'served-bob-uid';
      const aliceEmail = 'alice-replay@example.test';
      const bobEmail = 'bob-replay@example.test';
      const password = 'replay-password-123';

      const ctx = await createContext({
        rules: {
          '.read': false,
          '.write': false,
          pyric_oracle: {
            [runId]: AUTH_CHANGE_LIVE_ROUTING_RUN_RULES,
          },
        },
      });

      const adminDb = await ctx.openAdminDb();
      const clientRtdb = ctx.db as unknown as client.ClientRtdb;
      const actorAuth = client.getAuth({
        __kind: 'client-db',
        port: clientRtdb.port,
      });

      await client.adminCreateUser(actorAuth, {
        uid: aliceUid,
        email: aliceEmail,
        password,
      });
      await client.adminCreateUser(actorAuth, {
        uid: bobUid,
        email: bobEmail,
        password,
      });

      const replayed = await observeAuthChangeLiveRouting({
        db: ctx.db as never,
        basePath,
        aliceUid,
        bobUid,
        ref: ctx.rtdb.ref as never,
        get: ctx.rtdb.get as never,
        set: ctx.rtdb.set as never,
        onValue: ctx.rtdb.onValue as never,
        onChildAdded: ctx.rtdb.onChildAdded as never,
        async seedAdminData(subpath, value) {
          await adminDb.ref(`${basePath}/${subpath}`).set(value);
        },
        async signInAs(role) {
          let email = bobEmail;
          if (role === 'alice') {
            email = aliceEmail;
          }
          await client.signInWithEmailAndPassword(actorAuth, email, password);
        },
        async signOut() {
          await client.signOut(actorAuth);
        },
      });

      expect(replayed.initialSignedOut.readAuthed.code).toBe('PERMISSION_DENIED');
      expect(replayed.afterSwitchToBob.readAliceOther.code).toBe('PERMISSION_DENIED');
      expect(replayed.afterSignOut.readAuthedDenied.code).toBe('PERMISSION_DENIED');
      expect(replayed).toEqual(withDeniedGetCode(observed, 'PERMISSION_DENIED'));
    });
  });
}
