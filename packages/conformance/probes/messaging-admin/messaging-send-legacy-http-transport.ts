import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging, type BatchResponse } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  summarizeBatchResponse,
  type SummarizedBatchResponse,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';
import { oracleAppOptions } from '../../src/oracle-credential.ts';

export interface LegacyHttpTransportSubject {
  projectId: string;
  runWithLegacyMessaging: () => Promise<{
    enableReturnIsUndefined: boolean;
    batch: BatchResponse;
  }>;
}

export async function observeLegacyHttpTransport(
  subject: LegacyHttpTransportSubject,
): Promise<{
  enableReturnIsUndefined: boolean;
  dryRunBatch: SummarizedBatchResponse;
}> {
  const { enableReturnIsUndefined, batch } = await subject.runWithLegacyMessaging();
  return {
    enableReturnIsUndefined,
    dryRunBatch: summarizeBatchResponse(batch, subject.projectId),
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  pendingRowLink: true,
  matrixRow: '',
  rowIds: [],
  description:
    'firebase-admin/messaging Messaging.enableLegacyHttpTransport(): returns undefined and switches sendEach to HTTP/1.1 transport with identical BatchResponse semantics.',
  async observe() {
    return withMessagingSendProbeSession(async ({ projectId, sa }) =>
      observeLegacyHttpTransport({
        projectId,
        runWithLegacyMessaging: async () => {
          const legacyApp = initializeApp(
            oracleAppOptions(sa),
            `messaging-legacy-http-${Date.now()}`,
          );
          try {
            const svc = getMessaging(legacyApp);
            const ret: unknown = svc.enableLegacyHttpTransport();
            const batch = await svc.sendEach(
              [
                {
                  topic: 'pyric-oracle-messaging-probe',
                  data: { transport: 'http1' },
                },
                {
                  token: 'not-a-real-fcm-registration-token',
                  data: { transport: 'http1' },
                },
              ],
              true,
            );
            return {
              enableReturnIsUndefined: ret === undefined,
              batch,
            };
          } finally {
            await deleteApp(legacyApp).catch(() => undefined);
          }
        },
      }),
    );
  },
};
