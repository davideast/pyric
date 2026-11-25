import admin from 'firebase-admin';
import {
  deleteApp,
  getApp,
  getApps,
  initializeApp,
  type App,
  type AppOptions,
} from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  extractMessagingErrorDetails,
  nameFacts,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';
import { oracleAppOptions } from '../../src/oracle-credential.ts';

export interface AdminEntryAccessorsSubject {
  projectId: string;
  appOptions?: AppOptions;
  dryRunTopicSend: (app: App) => Promise<string>;
}

export async function observeAdminEntryAccessors(
  subject: AdminEntryAccessorsSubject,
): Promise<Record<string, unknown>> {
  const preExistingDefault = getApps().find((existing) => existing.name === '[DEFAULT]');
  if (preExistingDefault !== undefined) {
    throw new Error(
      'messaging-send-admin-entry-accessors requires no pre-existing [DEFAULT] Firebase admin app',
    );
  }

  let noDefaultThrew = false;
  let noDefaultCode: string | null = null;
  try {
    getMessaging();
  } catch (err) {
    noDefaultThrew = true;
    noDefaultCode = extractMessagingErrorDetails(err).code;
  }

  const options: AppOptions = subject.appOptions ?? { projectId: subject.projectId };
  const createdApps: App[] = [];

  try {
    const defaultApp = initializeApp(options);
    createdApps.push(defaultApp);
    const namedAppName = `messaging-entry-named-${Date.now()}`;
    const namedApp = initializeApp(options, namedAppName);
    createdApps.push(namedApp);

    const resolvedDefaultApp = getApp();
    const resolvedNamedApp = getApp(namedAppName);

    const defaultViaGetMessaging = getMessaging();
    const defaultViaExplicit = getMessaging(defaultApp);
    const defaultViaResolvedApp = getMessaging(resolvedDefaultApp);
    const namedViaGetMessaging = getMessaging(namedApp);
    const namedViaResolvedApp = getMessaging(resolvedNamedApp);

    const legacyNamespaceMessaging = (
      admin as unknown as { readonly messaging?: (targetApp?: App) => unknown }
    ).messaging;
    let defaultMatchesLegacyNamespace = false;
    let namedMatchesLegacyNamespace = false;
    if (typeof legacyNamespaceMessaging === 'function') {
      defaultMatchesLegacyNamespace =
        defaultViaGetMessaging === legacyNamespaceMessaging() &&
        defaultViaGetMessaging === legacyNamespaceMessaging(resolvedDefaultApp);
      namedMatchesLegacyNamespace =
        namedViaGetMessaging === legacyNamespaceMessaging(resolvedNamedApp);
    }

    let invalidAppThrew = false;
    let invalidAppErrorName: string | null = null;
    try {
      getMessaging({} as App);
    } catch (err) {
      invalidAppThrew = true;
      invalidAppErrorName = extractMessagingErrorDetails(err).name;
    }

    const dryRunName = await subject.dryRunTopicSend(namedApp);

    return {
      noDefaultAppThrows: {
        threw: noDefaultThrew,
        code: noDefaultCode,
      },
      defaultGetMessagingMatchesExplicit:
        defaultViaGetMessaging === defaultViaExplicit &&
        defaultViaGetMessaging === defaultViaResolvedApp,
      defaultGetMessagingMatchesNamespace: defaultMatchesLegacyNamespace,
      defaultAppGetterMatchesDefaultApp: defaultViaGetMessaging.app === defaultApp,
      namedGetMessagingMatchesNamespace: namedMatchesLegacyNamespace,
      namedAppGetterMatchesNamedApp:
        namedViaGetMessaging.app === namedApp && namedViaResolvedApp === namedViaGetMessaging,
      namedDistinctFromDefault: namedViaGetMessaging !== defaultViaGetMessaging,
      invalidAppArgument: {
        threw: invalidAppThrew,
        errorName: invalidAppErrorName,
      },
      namedDryRunSend: nameFacts(dryRunName, subject.projectId),
    };
  } finally {
    for (const created of createdApps) {
      await deleteApp(created).catch(() => undefined);
    }
  }
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "getMessaging(app?), messaging(app?), and Messaging.app",
  rowIds: ['messaging-admin#1', 'messaging-admin#2', 'messaging-admin#3'],
  description:
    'firebase-admin/messaging getMessaging(app?), admin.messaging(app?), and Messaging.app: default vs named app resolution, per-app instance caching across modular and namespace entrypoints, invalid-app TypeError guard, and live dryRun topic send.',
  async observe() {
    return withMessagingSendProbeSession(async ({ projectId, sa }) =>
      observeAdminEntryAccessors({
        projectId,
        appOptions: oracleAppOptions(sa),
        dryRunTopicSend: async (targetApp) =>
          getMessaging(targetApp).send(
            {
              topic: 'pyric-oracle-messaging-probe',
              data: { probe: 'admin-entry-accessors' },
            },
            true,
          ),
      }),
    );
  },
};
