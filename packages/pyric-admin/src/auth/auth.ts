/**
 * App-bound `Auth` service class (`firebase-admin/auth` `Auth extends BaseAuth`, v13.10.0).
 */
import type { PyricAdminApp } from '../app/index.js';
import { BaseAuth } from './base-auth.js';
import type { BaseAuthDelegate } from './types.js';

export class Auth extends BaseAuth {
  private readonly boundApp: PyricAdminApp;
  private readonly throwUnmodeledManager: (method: string) => never;

  constructor(
    app: PyricAdminApp,
    delegate: BaseAuthDelegate,
    throwUnmodeledManager: (method: string) => never,
  ) {
    super(delegate);
    this.boundApp = app;
    this.throwUnmodeledManager = throwUnmodeledManager;
  }

  get app(): PyricAdminApp {
    return this.boundApp;
  }

  get tenantManager(): never {
    return this.throwUnmodeledManager('tenantManager');
  }

  get projectConfigManager(): never {
    return this.throwUnmodeledManager('projectConfigManager');
  }
}
