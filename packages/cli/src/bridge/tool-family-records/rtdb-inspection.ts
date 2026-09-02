import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 40,
  tools: ['rtdb_simulate_access', 'rtdb_crawl_structure'],
} as const satisfies ToolFamilyRecord;
