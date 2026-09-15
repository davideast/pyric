import type { AttachAckFromBridge } from './protocol.js';

/** Check attachment metadata before it becomes connection or routing state. */
export function hasValidAttachFields(frame: AttachAckFromBridge): boolean {
  const hasRequiredFields = typeof frame.bridgeVersion === 'string'
    && typeof frame.peerConnected === 'boolean' && typeof frame.clientSessionId === 'string';
  const optionalText = [frame.projectKey, frame.serveVersion, frame.sessionId, frame.resumeToken, frame.hostInstanceId];
  const hasValidText = optionalText.every(value => value === undefined || typeof value === 'string');
  const capabilities = frame.capabilities;
  const hasValidCapabilities = capabilities === undefined
    || Array.isArray(capabilities) && capabilities.every(value => typeof value === 'string');
  const hasValidPresence = frame.sandboxConnected === undefined || typeof frame.sandboxConnected === 'boolean';
  return hasRequiredFields && hasValidText && hasValidCapabilities && hasValidPresence;
}
