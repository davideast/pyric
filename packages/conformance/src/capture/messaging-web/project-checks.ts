/**
 * The checks that keep the web receive plane on one project: the web config,
 * its sender id, and the VAPID key must all belong to the project the send
 * credential sends for. A token minted under one project cannot receive a
 * send from another, so a mismatch would fail every scenario after minutes of
 * headed-browser setup. These run before the browser opens.
 *
 * What can be read without a request:
 *   - the web config's `projectId` against the credential's project;
 *   - the sender id: `messagingSenderId` is the project number, and the web
 *     `appId` (`1:<project number>:web:<hash>`) carries the same number;
 *   - the VAPID key's form: a base64url uncompressed P-256 public key.
 * A VAPID public key names no project, so its project is checked by FCM when
 * `getToken` registers the browser.
 */

/** The web config fields the checks read. */
export interface MessagingWebConfig {
  projectId?: string;
  appId?: string;
  messagingSenderId?: string;
}

const PROJECT_NUMBER_PATTERN = /^\d+$/;
const WEB_APP_ID_PATTERN = /^1:(\d+):web:[^:]+$/;
const UNCOMPRESSED_P256_POINT_BYTES = 65;
const UNCOMPRESSED_POINT_PREFIX = 0x04;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Every reason the web config and VAPID key do not belong to `projectId`. Empty when they do. */
export function messagingWebProjectProblems(
  config: MessagingWebConfig,
  vapidKey: string,
  projectId: string,
): string[] {
  return [
    ...projectProblems(config, projectId),
    ...senderProblems(config),
    ...vapidKeyProblems(vapidKey),
  ];
}

function projectProblems(config: MessagingWebConfig, projectId: string): string[] {
  if (config.projectId === projectId) return [];
  return [
    `PYRIC_MESSAGING_FIREBASE_CONFIG is for project ${config.projectId ?? '(none)'}, but the send credential is for ${projectId}. Token registration and sends need the same project.`,
  ];
}

function senderProblems(config: MessagingWebConfig): string[] {
  const senderId = config.messagingSenderId ?? '';
  if (!PROJECT_NUMBER_PATTERN.test(senderId)) {
    return [`PYRIC_MESSAGING_FIREBASE_CONFIG has no numeric messagingSenderId (found ${senderId || '(none)'}).`];
  }
  const appProjectNumber = WEB_APP_ID_PATTERN.exec(config.appId ?? '')?.[1];
  if (appProjectNumber === senderId) return [];
  return [
    `PYRIC_MESSAGING_FIREBASE_CONFIG has messagingSenderId ${senderId}, but its appId ${config.appId ?? '(none)'} is not a web app of that project number.`,
  ];
}

function vapidKeyProblems(vapidKey: string): string[] {
  if (isUncompressedP256Key(vapidKey)) return [];
  return [
    'PYRIC_MESSAGING_VAPID_KEY is not a Web Push certificate public key (a base64url uncompressed P-256 point). Copy the key pair value from Project settings, Cloud Messaging, Web configuration.',
  ];
}

function isUncompressedP256Key(vapidKey: string): boolean {
  if (!BASE64URL_PATTERN.test(vapidKey)) return false;
  const bytes = Buffer.from(vapidKey, 'base64url');
  return bytes.length === UNCOMPRESSED_P256_POINT_BYTES && bytes[0] === UNCOMPRESSED_POINT_PREFIX;
}
