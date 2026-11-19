import { describe, expect, it } from 'bun:test';
import { deleteApp as deleteAdminApp, initializeApp as initializeAdminApp } from 'pyric-admin/app';
import { getDatabase as getAdminDatabase } from 'pyric-admin/database';
import {
  observeAdminUseEmulatorContract,
  type AdminUseEmulatorSdk,
} from '../../../../../conformance/probes/rtdb-modular/rtdb-modular-admin-use-emulator-validation.ts';
import {
  hostedRtdbContext,
  load,
  restoreSharedWorker,
  servedRtdbContext,
  type ServedRtdbAdminContext,
} from './support.ts';

restoreSharedWorker();

type AdminPlaneFactory = () => Promise<ServedRtdbAdminContext>;

const PLANES: ReadonlyArray<[string, AdminPlaneFactory]> = [
  ['served SharedWorker', () => servedRtdbContext()],
  ['served Node host', () => hostedRtdbContext()],
];

let appSeq = 0;

for (const [planeLabel, createContext] of PLANES) {
  describe(`RTDB admin Database#useEmulator oracle capture (${planeLabel})`, () => {
    it('rtdb-modular-admin-use-emulator-validation (rtdb-admin#9)', async () => {
      const ctx = await createContext();
      const observed = load('rtdb-modular-admin-use-emulator-validation');
      const { fetchCalls, ...expectedContract } = observed;
      expect(fetchCalls).toBe(0);

      const sdk: AdminUseEmulatorSdk = {
        createApp(options, label) {
          appSeq += 1;
          // Each app binds to the plane's served/hosted RemoteSandbox channel.
          return initializeAdminApp(
            {
              sandbox: remoteSandbox,
              projectId: options.projectId,
              databaseURL: options.databaseURL,
            },
            `served-admin-emu-${appSeq}-${label}`,
          ) as unknown as ReturnType<AdminUseEmulatorSdk['createApp']>;
        },
        getDatabase(app) {
          return getAdminDatabase(
            app as unknown as Parameters<typeof getAdminDatabase>[0],
          ) as unknown as ReturnType<AdminUseEmulatorSdk['getDatabase']>;
        },
        deleteApp(app) {
          return deleteAdminApp(app as unknown as Parameters<typeof deleteAdminApp>[0]);
        },
      };

      const remoteSandbox = await ctx.openRemoteSandbox();
      const actual = await observeAdminUseEmulatorContract(sdk);
      expect(actual as unknown).toEqual(expectedContract);

      // Verify live read/write routing over the served SharedWorker / Node host after useEmulator.
      const liveSandbox = await ctx.openRemoteSandbox();
      const liveApp = initializeAdminApp(
        {
          sandbox: liveSandbox,
          projectId: 'demo-served-emu',
          databaseURL: 'https://demo-served-emu-default-rtdb.firebaseio.com',
        },
        `served-admin-emu-live-${++appSeq}`,
      );
      try {
        const cleanBase = ctx.base.replace(/^\/+|\/+$/g, '');
        const liveDb = getAdminDatabase(liveApp);
        liveDb.useEmulator('127.0.0.1', 9000);
        const targetRef = liveDb.ref(`${cleanBase}/useEmulatorRoundtrip`);
        expect(targetRef.toString()).toBe(
          `http://127.0.0.1:9000/${cleanBase}/useEmulatorRoundtrip`,
        );
        await targetRef.set({ ok: true, plane: planeLabel });
        const snap = await liveDb
          .refFromURL(`http://127.0.0.1:9000/${cleanBase}/useEmulatorRoundtrip`)
          .get();
        expect(snap.val()).toEqual({ ok: true, plane: planeLabel });
      } finally {
        await deleteAdminApp(liveApp);
      }
    });
  });
}
