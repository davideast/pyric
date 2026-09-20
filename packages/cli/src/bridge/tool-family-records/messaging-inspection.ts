import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 100,
  tools: { messaging_deliveries: 'read' },
} as const satisfies ToolFamilyRecord;
