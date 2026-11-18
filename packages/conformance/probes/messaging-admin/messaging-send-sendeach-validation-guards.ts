import { getMessaging, type BatchResponse, type Message } from 'firebase-admin/messaging';
import type { Probe } from '../../rigs/types.ts';
import {
  type CapturedMessagingCallOutcome,
  captureMessagingCall,
  withMessagingSendProbeSession,
} from '../../src/messaging-send-probe-session.ts';

export interface SendEachValidationGuardsSubject {
  sendEachRaw: (messages: unknown, dryRun?: unknown) => Promise<BatchResponse>;
}

export async function observeSendEachValidationGuards(
  subject: SendEachValidationGuardsSubject,
): Promise<{
  emptyArray: CapturedMessagingCallOutcome;
  overMaxBatch501: CapturedMessagingCallOutcome;
  nonBooleanDryRun: CapturedMessagingCallOutcome;
}> {
  const oversizedBatch = Array.from({ length: 501 }, (_, idx) => ({
    topic: 'pyric-oracle-messaging-probe',
    data: { item: String(idx) },
  }));

  const emptyArray = await captureMessagingCall(() => subject.sendEachRaw([], true));
  const overMaxBatch501 = await captureMessagingCall(() =>
    subject.sendEachRaw(oversizedBatch, true),
  );
  const nonBooleanDryRun = await captureMessagingCall(() =>
    subject.sendEachRaw([{ topic: 'pyric-oracle-messaging-probe' }], 'yes'),
  );

  return {
    emptyArray,
    overMaxBatch501,
    nonBooleanDryRun,
  };
}

export const probe: Probe = {
  rig: 'messaging-send',
  matrixRow: "Messaging.sendEach(messages, dryRun?) input guards and FirebaseMessagingError",
  rowIds: ['messaging-admin#5', 'messaging-admin#38'],
  description:
    'firebase-admin/messaging sendEach(messages, dryRun?) input guards: empty array, >500-message batch, and non-boolean dryRun fail preflight with FirebaseMessagingError messaging/invalid-argument.',
  async observe() {
    return withMessagingSendProbeSession(async ({ app }) =>
      observeSendEachValidationGuards({
        sendEachRaw: async (messages, dryRun) =>
          getMessaging(app).sendEach(
            messages as Message[],
            dryRun as boolean | undefined,
          ),
      }),
    );
  },
};
