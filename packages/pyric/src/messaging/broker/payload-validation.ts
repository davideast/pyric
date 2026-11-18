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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
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

function isSixOrEightDigitHexColor(value: unknown): boolean {
  return typeof value === 'string' && (/^#[0-9a-fA-F]{6}$/.test(value) || /^#[0-9a-fA-F]{8}$/.test(value));
}

function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && !Number.isNaN(value);
}

function isNonNegativeMillisecondDuration(value: unknown): boolean {
  return isValidNumber(value) && value >= 0;
}

function validateNoDuplicateMappedKeys(
  obj: Record<string, unknown>,
  mappings: ReadonlyArray<readonly [string, string]>,
  typeName: string,
): void {
  for (const [camelKey, wireKey] of mappings) {
    if (camelKey in obj && wireKey in obj) {
      throwInvalidPayload(`Multiple specifications for ${camelKey} in ${typeName}`);
    }
  }
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
  validateNoDuplicateMappedKeys(obj, [['imageUrl', 'image']], 'ApnsFcmOptions');
}

function validateNotificationObject(notification: unknown): void {
  if (notification === undefined) {
    return;
  }
  const obj = assertNonNullObject(notification, 'notification');
  if (obj.imageUrl !== undefined && !isValidHttpUrl(obj.imageUrl)) {
    throwInvalidPayload('notification.imageUrl must be a valid URL string');
  }
  validateNoDuplicateMappedKeys(obj, [['imageUrl', 'image']], 'Notification');
}

function validateWebpushObject(webpush: unknown): void {
  if (webpush === undefined) {
    return;
  }
  const obj = assertNonNullObject(webpush, 'webpush');
  validateStringMap(obj.headers, 'webpush.headers');
  validateStringMap(obj.data, 'webpush.data');
}

function validateLightSettingsObject(lightSettings: unknown): void {
  if (lightSettings === undefined) {
    return;
  }
  const obj = assertNonNullObject(lightSettings, 'android.notification.lightSettings');
  if (!isNonNegativeMillisecondDuration(obj.lightOnDurationMillis)) {
    throwInvalidPayload(
      'android.notification.lightSettings.lightOnDurationMillis must be a non-negative duration in milliseconds',
    );
  }
  if (!isNonNegativeMillisecondDuration(obj.lightOffDurationMillis)) {
    throwInvalidPayload(
      'android.notification.lightSettings.lightOffDurationMillis must be a non-negative duration in milliseconds',
    );
  }
  if (!isSixOrEightDigitHexColor(obj.color)) {
    throwInvalidPayload(
      'android.notification.lightSettings.color must be in the form #RRGGBB or #RRGGBBAA format',
    );
  }
}

function validateAndroidNotificationObject(notification: unknown): void {
  if (notification === undefined) {
    return;
  }
  const androidNotif = assertNonNullObject(notification, 'android.notification');
  if (androidNotif.color !== undefined && !isSixDigitHexColor(androidNotif.color)) {
    throwInvalidPayload('android.notification.color must be in the form #RRGGBB');
  }
  if (isNonEmptyArray(androidNotif.bodyLocArgs) && !isNonEmptyString(androidNotif.bodyLocKey)) {
    throwInvalidPayload('android.notification.bodyLocKey is required when specifying bodyLocArgs');
  }
  if (isNonEmptyArray(androidNotif.titleLocArgs) && !isNonEmptyString(androidNotif.titleLocKey)) {
    throwInvalidPayload(
      'android.notification.titleLocKey is required when specifying titleLocArgs',
    );
  }
  if (androidNotif.imageUrl !== undefined && !isValidHttpUrl(androidNotif.imageUrl)) {
    throwInvalidPayload('android.notification.imageUrl must be a valid URL string');
  }
  if (androidNotif.eventTimestamp !== undefined && !(androidNotif.eventTimestamp instanceof Date)) {
    throwInvalidPayload('android.notification.eventTimestamp must be a valid `Date` object');
  }
  if (androidNotif.vibrateTimingsMillis !== undefined) {
    if (!isNonEmptyArray(androidNotif.vibrateTimingsMillis)) {
      throwInvalidPayload(
        'android.notification.vibrateTimingsMillis must be a non-empty array of numbers',
      );
    }
    for (const item of androidNotif.vibrateTimingsMillis) {
      if (!isNonNegativeMillisecondDuration(item)) {
        throwInvalidPayload(
          'android.notification.vibrateTimingsMillis must be non-negative durations in milliseconds',
        );
      }
    }
  }
  validateLightSettingsObject(androidNotif.lightSettings);
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
  validateAndroidNotificationObject(obj.notification);
  validateFcmOptionsObject(obj.fcmOptions);
}

function validateApsAlertObject(alert: unknown): void {
  if (alert === undefined || typeof alert === 'string') {
    return;
  }
  if (!isNonNullPlainObject(alert)) {
    throwInvalidPayload('apns.payload.aps.alert must be a string or a non-null object');
  }
  if (isNonEmptyArray(alert.locArgs) && !isNonEmptyString(alert.locKey)) {
    throwInvalidPayload('apns.payload.aps.alert.locKey is required when specifying locArgs');
  }
  if (isNonEmptyArray(alert.titleLocArgs) && !isNonEmptyString(alert.titleLocKey)) {
    throwInvalidPayload(
      'apns.payload.aps.alert.titleLocKey is required when specifying titleLocArgs',
    );
  }
  if (isNonEmptyArray(alert.subtitleLocArgs) && !isNonEmptyString(alert.subtitleLocKey)) {
    throwInvalidPayload(
      'apns.payload.aps.alert.subtitleLocKey is required when specifying subtitleLocArgs',
    );
  }
}

function validateApsSoundObject(sound: unknown): void {
  if (sound === undefined || isNonEmptyString(sound)) {
    return;
  }
  if (!isNonNullPlainObject(sound)) {
    throwInvalidPayload('apns.payload.aps.sound must be a non-empty string or a non-null object');
  }
  if (!isNonEmptyString(sound.name)) {
    throwInvalidPayload('apns.payload.aps.sound.name must be a non-empty string');
  }
  if (sound.volume !== undefined) {
    if (!isValidNumber(sound.volume)) {
      throwInvalidPayload('apns.payload.aps.sound.volume must be a number');
    }
    if (sound.volume < 0 || sound.volume > 1) {
      throwInvalidPayload('apns.payload.aps.sound.volume must be in the interval [0, 1]');
    }
  }
}

function validateApsObject(aps: unknown): void {
  if (aps === undefined) {
    return;
  }
  const obj = assertNonNullObject(aps, 'apns.payload.aps');
  validateApsAlertObject(obj.alert);
  validateApsSoundObject(obj.sound);
  validateNoDuplicateMappedKeys(
    obj,
    [
      ['contentAvailable', 'content-available'],
      ['mutableContent', 'mutable-content'],
      ['threadId', 'thread-id'],
    ],
    'Aps',
  );
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
    validateApsObject(payload.aps);
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
