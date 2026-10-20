/**
 * `pyric-admin/phone-number-verification`: deferred service handle for `firebase-admin/phone-number-verification`.
 */
import type { PyricAdminApp } from '../app/index.js';
import { guardDeferredServiceApp, wireDeferredService } from '../deferred.js';

export { PyricDeferredApiError } from '../deferred.js';

export class PhoneNumberVerification {
  readonly #app: PyricAdminApp;

  /** @internal */
  constructor(...args: unknown[]) {
    this.#app = guardDeferredServiceApp(
      'phone-number-verification',
      'PhoneNumberVerification',
      args,
    );
  }

  get app(): PyricAdminApp {
    return this.#app;
  }

  declare verifyToken: (...args: unknown[]) => Promise<never>;
}

export const getPhoneNumberVerification: (app?: PyricAdminApp) => PhoneNumberVerification =
  wireDeferredService(
    PhoneNumberVerification,
    'phone-number-verification',
    'PhoneNumberVerification',
    {
      async: ['verifyToken'],
    },
  );
