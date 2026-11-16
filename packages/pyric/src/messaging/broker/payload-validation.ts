/**
 * Client-payload shape validation aligned with `firebase-admin/messaging`
 * (`messaging-internal.js`), producing `INVALID_PAYLOAD` envelopes that map to
 * `messaging/invalid-payload` on the Admin SDK surface.
 */

import { BrokerSendError, invalidPayloadEnvelope } from './envelopes.js';

export function isNonNullPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwInvalidPayload(message: string): never {
  throw new BrokerSendError(invalidPayloadEnvelope(message));
}

function assertNonNullObject(value: unknown, label: string): Record<string, unknown> {
  if (!isNonNullPlainObject(value)) {
    throwInvalidPayload(`${label} must be a non-null object`);
  }
  return value;
}

function validateStringMap(map: unknown, label: string): void {
  if (map === undefined) {
    return;
  }
  const obj = assertNonNullObject(map, label);
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] !== 'string') {
      throwInvalidPayload(`${label} must only contain string values`);
    }
  }
}

function isValidHttpUrl(urlStr: unknown): boolean {
  if (typeof urlStr !== 'string') {
    return false;
  }
  if (/[^a-z0-9:/?#[\]@!$&'()*+,;=.\-_~%]/i.test(urlStr)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const hostname = parsed.hostname;
  const domainRe = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
  const ipv6Re = /^\[[a-fA-F0-9:.]+\]$/;
  if (!domainRe.test(hostname) && !ipv6Re.test(hostname)) {
    return false;
  }
  const pathname = parsed.pathname;
  const pathnameRe = /^(\/[\w\-.~!$'()*+,;=:@%]+)*\/?$/;
  if (pathname.length > 0 && pathname !== '/' && !pathnameRe.test(pathname)) {
    return false;
  }
  return true;
}

function isSixDigitHexColor(value: unknown): boolean {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function isNonNegativeMillisecondDuration(value: unknown): boolean {
  return typeof value === 'number' && !Number.isNaN(value) && value >= 0;
}

function validateFcmOptionsObject(fcmOptions: unknown): void {
  if (fcmOptions === undefined) {
    return;
  }
  const obj = assertNonNullObject(fcmOptions, 'fcmOptions');
  if (obj.analyticsLabel !== undefined && typeof obj.analyticsLabel !== 'string') {
    throwInvalidPayload('analyticsLabel must be a string value');
  }
}

function validateApnsFcmOptionsObject(fcmOptions: unknown): void {
  if (fcmOptions === undefined) {
    return;
  }
  const obj = assertNonNullObject(fcmOptions, 'fcmOptions');
  if (obj.imageUrl !== undefined && !isValidHttpUrl(obj.imageUrl)) {
    throwInvalidPayload('imageUrl must be a valid URL string');
  }
  if (obj.analyticsLabel !== undefined && typeof obj.analyticsLabel !== 'string') {
    throwInvalidPayload('analyticsLabel must be a string value');
  }
  if ('imageUrl' in obj && 'image' in obj) {
    throwInvalidPayload('Multiple specifications for imageUrl in ApnsFcmOptions');
  }
}

function validateNotificationObject(notification: unknown): void {
  if (notification === undefined) {
    return;
  }
  const obj = assertNonNullObject(notification, 'notification');
  if (obj.imageUrl !== undefined && !isValidHttpUrl(obj.imageUrl)) {
    throwInvalidPayload('notification.imageUrl must be a valid URL string');
  }
  if ('imageUrl' in obj && 'image' in obj) {
    throwInvalidPayload('Multiple specifications for imageUrl in Notification');
  }
}

function validateWebpushObject(webpush: unknown): void {
  if (webpush === undefined) {
    return;
  }
  const obj = assertNonNullObject(webpush, 'webpush');
  validateStringMap(obj.headers, 'webpush.headers');
  validateStringMap(obj.data, 'webpush.data');
}

function validateAndroidObject(android: unknown): void {
  if (android === undefined) {
    return;
  }
  const obj = assertNonNullObject(android, 'android');
  if (obj.ttl !== undefined && !isNonNegativeMillisecondDuration(obj.ttl)) {
    throwInvalidPayload('TTL must be a non-negative duration in milliseconds');
  }
  validateStringMap(obj.data, 'android.data');
  if (obj.notification !== undefined) {
    const androidNotif = assertNonNullObject(obj.notification, 'android.notification');
    if (androidNotif.color !== undefined && !isSixDigitHexColor(androidNotif.color)) {
      throwInvalidPayload('android.notification.color must be in the form #RRGGBB');
    }
    if (androidNotif.imageUrl !== undefined && !isValidHttpUrl(androidNotif.imageUrl)) {
      throwInvalidPayload('android.notification.imageUrl must be a valid URL string');
    }
  }
  validateFcmOptionsObject(obj.fcmOptions);
}

function validateApnsObject(apns: unknown): void {
  if (apns === undefined) {
    return;
  }
  const obj = assertNonNullObject(apns, 'apns');
  if (obj.liveActivityToken !== undefined) {
    if (typeof obj.liveActivityToken !== 'string') {
      throwInvalidPayload('apns.liveActivityToken must be a string value');
    }
    if (obj.liveActivityToken.length === 0) {
      throwInvalidPayload('apns.liveActivityToken must be a non-empty string');
    }
  }
  validateStringMap(obj.headers, 'apns.headers');
  if (obj.payload !== undefined) {
    const payload = assertNonNullObject(obj.payload, 'apns.payload');
    if (payload.aps !== undefined) {
      assertNonNullObject(payload.aps, 'apns.payload.aps');
    }
  }
  validateApnsFcmOptionsObject(obj.fcmOptions);
}

/**
 * Validates `Message` payload and platform-config fields (`data`, `android`,
 * `webpush`, `apns`, `fcmOptions`, `notification`).
 */
export function validateMessagePayloadFields(message: Record<string, unknown>): void {
  validateStringMap(message.data, 'data');
  validateAndroidObject(message.android);
  validateWebpushObject(message.webpush);
  validateApnsObject(message.apns);
  validateFcmOptionsObject(message.fcmOptions);
  validateNotificationObject(message.notification);
}
