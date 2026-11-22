import { hasValidAttachFields } from '../../../bridge/attach-validation.js';
import {
  STORAGE_BYTE_ROUTE_CAPABILITY,
  WORKER_PORT_CAPABILITY,
  type BridgeMessage,
} from '../../../bridge/protocol.js';
import { hostRestartedSincePageLoad, type HostRestart } from '../../runtime/host-restart.js';

type AttachAckFrame = Extract<BridgeMessage, { type: 'attach-ack' }>;

type AttachAckTransportResult =
  | { ok: false; error: string }
  | { ok: true; offersByteRoute: boolean };

export function validateAttachAckTransport(message: AttachAckFrame): AttachAckTransportResult {
  const isUnsupportedProtocol = message.protocol !== 1;
  if (isUnsupportedProtocol) {
    return {
      ok: false,
      error: 'The hosted sandbox uses an unsupported bridge protocol. Expected version 1.',
    };
  }
  const capabilities = message.capabilities;
  const hasCapabilityList = Array.isArray(capabilities);
  const hasNamedCapabilities =
    hasCapabilityList && capabilities.every(capability => typeof capability === 'string');
  const supportsWorkerPorts =
    hasNamedCapabilities && capabilities.includes(WORKER_PORT_CAPABILITY);
  if (!supportsWorkerPorts) {
    return {
      ok: false,
      error:
        'The selected host does not support browser worker ports. Upgrade @pyric/cli, restart with --hosted, and reload this page.',
    };
  }
  return {
    ok: true,
    offersByteRoute: capabilities.includes(STORAGE_BYTE_ROUTE_CAPABILITY),
  };
}

interface AttachAckSessionInput {
  projectKey: string;
  hasEverAttached: boolean;
  hostInstanceId: string | undefined;
  presentedHostInstanceId: string | undefined;
  fromPriorHost: boolean;
  isPageRealm: boolean;
  reportedHostRestart: boolean;
  initialHostInstanceId: string | undefined;
  requestsFreshSession: boolean;
  resumeToken: string | undefined;
}

type AttachAckSessionResult =
  | {
      ok: false;
      error: string;
      fromPriorHost: boolean;
      hostRestart?: HostRestart;
    }
  | {
      ok: true;
      isResume: boolean;
      fromPriorHost: boolean;
      hostRestart?: HostRestart;
      resumeToken: string | undefined;
      hostInstanceId: string | undefined;
      restoresSession: boolean;
    };

export function classifyAttachAckSession(
  message: AttachAckFrame,
  input: AttachAckSessionInput,
): AttachAckSessionResult {
  const isDifferentProject = message.projectKey !== input.projectKey;
  if (isDifferentProject) {
    return {
      ok: false,
      error: 'The selected hosted sandbox belongs to a different project.',
      fromPriorHost: input.fromPriorHost,
    };
  }
  const hasMalformedAttachment = !hasValidAttachFields(message);
  if (hasMalformedAttachment) {
    return {
      ok: false,
      error: 'The hosted sandbox sent a malformed attachment acknowledgment.',
      fromPriorHost: input.fromPriorHost,
    };
  }
  const isResume = input.hasEverAttached;
  const hasHostIdentity =
    typeof message.hostInstanceId === 'string' && message.hostInstanceId.length > 0;
  const changedHost =
    isResume &&
    input.hostInstanceId !== undefined &&
    hasHostIdentity &&
    message.hostInstanceId !== input.hostInstanceId;
  const presentedThisHost =
    hasHostIdentity && message.hostInstanceId === input.presentedHostInstanceId;
  const fromPriorHost = changedHost && !presentedThisHost ? true : input.fromPriorHost;
  // Only a page runs a bundle its host served; a Node process or service worker has no stale tab to reload.
  const bootIds = {
    initialHostInstanceId: input.initialHostInstanceId,
    currentHostInstanceId: message.hostInstanceId,
  };
  let hostRestart: HostRestart | undefined;
  if (input.isPageRealm && !input.reportedHostRestart && hostRestartedSincePageLoad(bootIds)) {
    hostRestart = bootIds;
  }
  const attemptsResume = isResume && !input.requestsFreshSession;
  const receivedDifferentGrant = message.resumeToken !== input.resumeToken;
  const changedSessionUnexpectedly = attemptsResume && receivedDifferentGrant && !changedHost;
  if (changedSessionUnexpectedly) {
    return {
      ok: false,
      error: 'The hosted session could not be resumed.',
      fromPriorHost,
      hostRestart,
    };
  }
  const hasResumeToken =
    typeof message.resumeToken === 'string' && message.resumeToken.length > 0;
  const resumeToken = hasResumeToken ? message.resumeToken : undefined;
  const hostInstanceId = hasHostIdentity ? message.hostInstanceId : undefined;
  const restoresSession = isResume && (changedHost || input.requestsFreshSession);
  return {
    ok: true,
    isResume,
    fromPriorHost,
    hostRestart,
    resumeToken,
    hostInstanceId,
    restoresSession,
  };
}
