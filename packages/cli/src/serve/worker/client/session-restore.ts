import type { DiagnosticEvent } from '../../runtime/diagnostics-report.js';
import type { InboundMessage } from '../protocol.js';
import {
  rawRpc,
  restoreAuthSubscriptions,
  restoreMessagingSubscriptions,
  restoreObservationSubscriptions,
} from './core.js';
import type { ClientPort } from './handles.js';
import type { HeldMessages } from './held-messages.js';

function formatAppConfigMessage(
  configuration: Extract<InboundMessage, { t: 'appConfig' }>,
  fromPriorHost: boolean,
): Extract<InboundMessage, { t: 'appConfig' }> {
  if (fromPriorHost) return { ...configuration, fromPriorHost: true };
  return configuration;
}

export async function runSessionRestorePass(options: {
  port: ClientPort;
  appConfig: Extract<InboundMessage, { t: 'appConfig' }> | undefined;
  fromPriorHost: boolean;
  postMessage: (message: InboundMessage) => void;
  replay: (message: InboundMessage) => void;
  isCurrentConnection: () => boolean;
  onRestoringState: (state: Extract<DiagnosticEvent['phase'], 'restoring'>) => void;
}): Promise<boolean> {
  options.onRestoringState('restoring');
  const configuration = options.appConfig;
  if (configuration !== undefined) {
    options.postMessage(formatAppConfigMessage(configuration, options.fromPriorHost));
  }
  await options.port.restoreAuth?.(message =>
    rawRpc(options.port, message, options.postMessage),
  );
  if (!options.isCurrentConnection()) return false;
  restoreAuthSubscriptions(options.port, options.replay);
  options.port.restoreObservedListeners?.(message =>
    rawRpc(options.port, message, options.postMessage),
  );
  return true;
}

export function replayResumedSubscriptions(options: {
  port: ClientPort;
  held: HeldMessages;
  appConfig: Extract<InboundMessage, { t: 'appConfig' }> | undefined;
  fromPriorHost: boolean;
  isResume: boolean;
  restoredSession: boolean;
  needsMessagingRestore: boolean;
  postMessage: (message: InboundMessage) => void;
  replay: (message: InboundMessage) => void;
}): void {
  if (options.isResume && !options.restoredSession) {
    // Same-host resume skips the full session restore pass, but an earlier
    // socket may have closed before the host read its flushed `appConfig`
    // (#1222). Resend `appConfig` ahead of resumed subscriptions and held ops
    // unless `held` already carries a newer `appConfig` frame.
    const configuration = options.appConfig;
    if (configuration !== undefined && !options.held.holdsAppConfig()) {
      options.postMessage(formatAppConfigMessage(configuration, options.fromPriorHost));
    }
  }
  if (options.isResume) {
    options.postMessage({ t: 'clock-subscribe' });
    restoreObservationSubscriptions(options.port, options.replay);
  }
  if (options.needsMessagingRestore) {
    restoreMessagingSubscriptions(options.port, options.replay);
  }
  // Held messages follow the whole restore, in the order the app issued them.
  options.held.flush(options.postMessage);
}
