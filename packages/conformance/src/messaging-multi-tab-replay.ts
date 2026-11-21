import type {
  MessagingMultiTabDeliveryRouting,
  MultiTabDeliveryCaseOutcome,
} from '../probes/messaging/messaging-web-multi-tab-routing.ts';

export type ReplayTabVisibility = 'visible' | 'hidden';

export interface ReplayMultiTabPayload {
  data?: Record<string, string>;
}

export interface MultiTabMessagingReplaySession {
  onTabAMessage(listener: (payload: ReplayMultiTabPayload) => void): () => void;
  onTabBMessage(listener: (payload: ReplayMultiTabPayload) => void): () => void;
  onSwBackgroundMessage(listener: (payload: ReplayMultiTabPayload) => void): () => void;
  setTabVisibilities(
    tabA: ReplayTabVisibility,
    tabB: ReplayTabVisibility,
  ): Promise<void> | void;
  deliver(spec: {
    notification: { title: string; body: string };
    data: Record<string, string>;
  }): Promise<void>;
  settleSubscriptions?(): Promise<void>;
  close(): Promise<void>;
}

function lastStepOf(payloads: ReadonlyArray<ReplayMultiTabPayload>): string | null {
  const latest = payloads[payloads.length - 1];
  if (latest?.data?.step !== undefined) {
    return latest.data.step;
  }
  return null;
}

export async function replayMessagingMultiTabRouting(
  createSession: () => Promise<MultiTabMessagingReplaySession>,
): Promise<MessagingMultiTabDeliveryRouting> {
  const session = await createSession();
  const tabAPayloads: ReplayMultiTabPayload[] = [];
  const tabBPayloads: ReplayMultiTabPayload[] = [];
  const swPayloads: ReplayMultiTabPayload[] = [];

  const unsubTabA = session.onTabAMessage((payload) => {
    tabAPayloads.push(payload);
  });
  const unsubTabB = session.onTabBMessage((payload) => {
    tabBPayloads.push(payload);
  });
  const unsubSw = session.onSwBackgroundMessage((payload) => {
    swPayloads.push(payload);
  });

  try {
    if (session.settleSubscriptions !== undefined) {
      await session.settleSubscriptions();
    }

    await session.setTabVisibilities('visible', 'visible');
    await session.deliver({
      notification: { title: 'Notice', body: 'Two visible tabs' },
      data: { step: 'both-visible' },
    });
    const bothTabsVisible: MultiTabDeliveryCaseOutcome = {
      tabACount: tabAPayloads.length,
      tabBCount: tabBPayloads.length,
      swBackgroundCount: swPayloads.length,
      tabADataStep: lastStepOf(tabAPayloads),
      tabBDataStep: lastStepOf(tabBPayloads),
      swDataStep: lastStepOf(swPayloads),
    };

    tabAPayloads.length = 0;
    tabBPayloads.length = 0;
    swPayloads.length = 0;
    await session.setTabVisibilities('visible', 'hidden');
    await session.deliver({
      notification: { title: 'Notice', body: 'Mixed visibility tabs' },
      data: { step: 'one-visible' },
    });
    const oneVisibleOneHidden: MultiTabDeliveryCaseOutcome = {
      tabACount: tabAPayloads.length,
      tabBCount: tabBPayloads.length,
      swBackgroundCount: swPayloads.length,
      tabADataStep: lastStepOf(tabAPayloads),
      tabBDataStep: lastStepOf(tabBPayloads),
      swDataStep: lastStepOf(swPayloads),
    };

    tabAPayloads.length = 0;
    tabBPayloads.length = 0;
    swPayloads.length = 0;
    await session.setTabVisibilities('hidden', 'hidden');
    await session.deliver({
      notification: { title: 'Notice', body: 'All tabs hidden' },
      data: { step: 'all-hidden' },
    });
    const allTabsHidden: MultiTabDeliveryCaseOutcome = {
      tabACount: tabAPayloads.length,
      tabBCount: tabBPayloads.length,
      swBackgroundCount: swPayloads.length,
      tabADataStep: lastStepOf(tabAPayloads),
      tabBDataStep: lastStepOf(tabBPayloads),
      swDataStep: lastStepOf(swPayloads),
    };

    return {
      bothTabsVisible,
      oneVisibleOneHidden,
      allTabsHidden,
    };
  } finally {
    unsubTabA();
    unsubTabB();
    unsubSw();
    await session.close();
  }
}
