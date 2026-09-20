import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'in-process',
  order: 80,
  tools: {
    auth_impersonate: 'write',
    auth_reset: 'write',
    auth_whoami: 'read',
    auth_sessions: 'read',
  },
} as const satisfies ToolFamilyRecord;
