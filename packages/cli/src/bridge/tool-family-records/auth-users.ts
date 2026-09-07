import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 70,
  tools: [
    'auth_create_user',
    'auth_import_users',
    'auth_get_user',
    'auth_list_users',
    'auth_update_user',
    'auth_delete_user',
    'auth_set_claims',
    'auth_custom_token',
  ],
} as const satisfies ToolFamilyRecord;
