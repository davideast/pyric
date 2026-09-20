import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'in-process',
  order: 90,
  tools: {
    sandbox_save_capture: 'write',
    sandbox_list_captures: 'read',
    sandbox_open_capture: 'read',
    sandbox_rename_capture: 'write',
    sandbox_delete_capture: 'write',
  },
} as const satisfies ToolFamilyRecord;
