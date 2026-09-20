import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 70,
  tools: {
    auth_create_user: 'write',
    auth_import_users: 'write',
    auth_get_user: 'read',
    auth_list_users: 'read',
    auth_update_user: 'write',
    auth_delete_user: 'write',
    auth_set_claims: 'write',
    auth_custom_token: 'read',
  },
} as const satisfies ToolFamilyRecord;
