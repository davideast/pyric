import {
  isMessageRecord,
  requireOptionalBoolean,
  requireOptionalNumber,
  requireOptionalRecord,
  requireOptionalString,
  requireRecord,
  requireShape,
  requireString,
} from './fields.js';

function isPlainCrashlyticsScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function assertOptionalNullableString(value: unknown, field: string): void {
  const valid = value === undefined || value === null || typeof value === 'string';
  requireShape(valid, field);
}

function assertOptionalPlainRecord(value: unknown, field: string): void {
  if (value === undefined) {
    return;
  }
  requireRecord(value, field);
  const allPlain = Object.values(value).every(isPlainCrashlyticsScalar);
  requireShape(allPlain, field);
}

function assertOptionalBreadcrumbs(value: unknown): void {
  if (value === undefined) {
    return;
  }
  requireShape(Array.isArray(value), 'breadcrumbs');
  for (const item of value as unknown[]) {
    requireShape(isMessageRecord(item), 'breadcrumbs');
    const rec = item as Record<string, unknown>;
    requireString(rec.message, 'breadcrumbs.message');
    const validTs = typeof rec.timestampMs === 'number' && Number.isFinite(rec.timestampMs);
    requireShape(validTs, 'breadcrumbs.timestampMs');
    assertOptionalPlainRecord(rec.attributes, 'breadcrumbs.attributes');
  }
}

/** Validates inbound `crashlytics.*` worker operation arguments. */
export function assertCrashlyticsArguments(
  method: string,
  message: Record<string, unknown>,
): void {
  requireOptionalString(message.appId, 'appId');
  switch (method) {
    case 'crashlytics.recordError': {
      requireOptionalString(message.name, 'name');
      requireString(message.message, 'message');
      assertOptionalNullableString(message.stack, 'stack');
      assertOptionalNullableString(message.code, 'code');
      assertOptionalNullableString(message.cause, 'cause');
      requireOptionalBoolean(message.fatal, 'fatal');
      assertOptionalPlainRecord(message.attributes, 'attributes');
      assertOptionalBreadcrumbs(message.breadcrumbs);
      requireOptionalNumber(message.timestampMs, 'timestampMs');
      assertOptionalNullableString(message.appVersion, 'appVersion');
      assertOptionalNullableString(message.region, 'region');
      const platform = message.sdkPlatform;
      const validPlatform =
        platform === undefined ||
        platform === 'web' ||
        platform === 'android' ||
        platform === 'ios' ||
        platform === 'flutter';
      requireShape(validPlatform, 'sdkPlatform');
      requireOptionalBoolean(message.deferred, 'deferred');
      return;
    }
    case 'crashlytics.log':
      requireString(message.message, 'message');
      assertOptionalPlainRecord(message.attributes, 'attributes');
      requireOptionalNumber(message.timestampMs, 'timestampMs');
      return;
    case 'crashlytics.setUserId':
      requireString(message.userId, 'userId');
      return;
    case 'crashlytics.setCustomKeys': {
      requireRecord(message.keys, 'keys');
      const validKeys = Object.values(message.keys).every(isPlainCrashlyticsScalar);
      requireShape(validKeys, 'keys');
      return;
    }
    case 'crashlytics.setCollectionEnabled': {
      const enabled = message.enabled;
      const validEnabled =
        enabled === undefined || enabled === null || typeof enabled === 'boolean';
      requireShape(validEnabled, 'enabled');
      return;
    }
    case 'crashlytics.flush':
    case 'crashlytics.checkForUnsentReports':
    case 'crashlytics.sendUnsentReports':
    case 'crashlytics.deleteUnsentReports':
    case 'crashlytics.getState':
      return;
  }
}
