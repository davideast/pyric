import { deleteApp, getApp, initializeApp, type FirebaseApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import type { MessagingClientSwReplayTarget } from '../../../../packages/conformance/src/messaging-client-sw-replay.ts';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';

let replayAppSeq = 0;

export async function withInPageMessagingTarget<T>(
  loadClient: () => Promise<MessagingClientSwReplayTarget['clientMod']>,
  loadSw: () => Promise<MessagingClientSwReplayTarget['swMod']>,
  run: (target: MessagingClientSwReplayTarget) => Promise<T>,
): Promise<T> {
  const clientMod = await loadClient();
  const swMod = await loadSw();
  const ownedSandboxes = new Map<FirebaseApp, Sandbox>();
  const createdApps: FirebaseApp[] = [];

  const target: MessagingClientSwReplayTarget = {
    clientMod,
    swMod,
    async withNoDefaultApp(fn) {
      await resetAppRegistryForTests();
      try {
        return await fn();
      } finally {
        initializeApp({ projectId: 'messaging-oracle-conformance' });
      }
    },
    async withDefaultApp(fn) {
      return await fn(getApp());
    },
    createNamedApp(label) {
      replayAppSeq += 1;
      const sandbox = initializeSandbox();
      const app = createAppForSandbox(
        sandbox,
        { projectId: 'messaging-oracle-replay' },
        `inpage-msg-${label}-${replayAppSeq}`,
      );
      ownedSandboxes.set(app, sandbox);
      createdApps.push(app);
      return app;
    },
    async deleteApp(app) {
      const typedApp = app as FirebaseApp;
      await deleteApp(typedApp);
      const sb = ownedSandboxes.get(typedApp);
      if (sb !== undefined) {
        ownedSandboxes.delete(typedApp);
        sb.dispose();
      }
    },
    async deliver(messaging, spec) {
      const driver = clientMod.sandbox as {
        deliver(m: unknown, s: unknown): Promise<unknown>;
      };
      await driver.deliver(messaging, spec);
    },
  };

  try {
    return await run(target);
  } finally {
    for (const app of createdApps) {
      await deleteApp(app).catch(() => undefined);
      const sb = ownedSandboxes.get(app);
      if (sb !== undefined) {
        ownedSandboxes.delete(app);
        sb.dispose();
      }
    }
  }
}
