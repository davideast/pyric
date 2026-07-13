import type { App as AdminApp } from 'firebase-admin/app';
import { projectScopeFromAdminApp } from '../credentials/node/admin-app-scope.js';
import type { ProjectScope } from '../credentials/core/types.js';

/** Active deployment-surface spelling; removed with the deployment package. */
export function getDeploy(app: AdminApp): ProjectScope {
  return projectScopeFromAdminApp(app, 'getDeploy');
}
