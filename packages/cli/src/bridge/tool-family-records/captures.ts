import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'in-process',
  order: 90,
  tools: ['sandbox_save_capture', 'sandbox_list_captures', 'sandbox_open_capture', 'sandbox_rename_capture', 'sandbox_delete_capture'],
} as const satisfies ToolFamilyRecord;
