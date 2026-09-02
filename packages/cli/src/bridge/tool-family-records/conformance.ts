import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'in-process',
  order: 60,
  tools: ['pyric_can_i_use'],
} as const satisfies ToolFamilyRecord;
