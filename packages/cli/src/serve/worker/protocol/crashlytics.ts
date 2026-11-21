import type {
  CrashlyticsBreadcrumb,
  CrashlyticsSdkPlatform,
  PlainCrashlyticsValue,
} from 'pyric/crashlytics/internal';

/** All 10 `crashlytics.*` one-shot worker operation messages. */
export type CrashlyticsOpMessage =
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.recordError';
      appId?: string;
      name?: string;
      message: string;
      stack?: string | null;
      code?: string | null;
      cause?: string | null;
      fatal?: boolean;
      attributes?: Record<string, PlainCrashlyticsValue>;
      breadcrumbs?: CrashlyticsBreadcrumb[];
      timestampMs?: number;
      appVersion?: string | null;
      region?: string | null;
      sdkPlatform?: CrashlyticsSdkPlatform;
      deferred?: boolean;
    }
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.log';
      appId?: string;
      message: string;
      attributes?: Record<string, PlainCrashlyticsValue>;
      timestampMs?: number;
    }
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.flush';
      appId?: string;
    }
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.setUserId';
      appId?: string;
      userId: string;
    }
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.setCustomKeys';
      appId?: string;
      keys: Record<string, PlainCrashlyticsValue>;
    }
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.setCollectionEnabled';
      appId?: string;
      enabled: boolean | null;
    }
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.checkForUnsentReports';
      appId?: string;
    }
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.sendUnsentReports';
      appId?: string;
    }
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.deleteUnsentReports';
      appId?: string;
    }
  | {
      t: 'op';
      id: string;
      method: 'crashlytics.getState';
      appId?: string;
    };
