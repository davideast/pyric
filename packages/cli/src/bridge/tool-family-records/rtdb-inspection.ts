import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 40,
  tools: {
    rtdb_simulate_access: 'read',
    rtdb_crawl_structure: 'read',
  },
} as const satisfies ToolFamilyRecord;
