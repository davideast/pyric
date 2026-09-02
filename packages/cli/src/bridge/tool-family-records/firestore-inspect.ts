import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'forwarded',
  order: 30,
  tools: ['sandbox_inspect'],
} as const satisfies ToolFamilyRecord;
