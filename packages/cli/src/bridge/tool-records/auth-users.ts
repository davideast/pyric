import type { ToolRecord } from '../tool-records.js';
export default {
  name: 'auth_users',
  order: 88,
  description:
    'Users in the connected sandbox auth store: create and import users with claims, read and list them, update, delete, replace claims, and mint a custom token for sign-in.',
  ops: {
    create: { transport: 'forwarded', factory: 'auth-users', handler: 'auth_create_user' },
    import: { transport: 'forwarded', factory: 'auth-users', handler: 'auth_import_users' },
    get: { transport: 'forwarded', factory: 'auth-users', handler: 'auth_get_user' },
    list: { transport: 'forwarded', factory: 'auth-users', handler: 'auth_list_users' },
    update: { transport: 'forwarded', factory: 'auth-users', handler: 'auth_update_user' },
    delete: { transport: 'forwarded', factory: 'auth-users', handler: 'auth_delete_user' },
    set_claims: { transport: 'forwarded', factory: 'auth-users', handler: 'auth_set_claims' },
    custom_token: { transport: 'forwarded', factory: 'auth-users', handler: 'auth_custom_token' },
  },
} as const satisfies ToolRecord;
