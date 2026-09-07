import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'in-process',
  order: 80,
  tools: ['auth_impersonate', 'auth_reset', 'auth_whoami', 'auth_sessions'],
} as const satisfies ToolFamilyRecord;
