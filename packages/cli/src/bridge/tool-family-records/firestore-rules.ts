import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'in-process',
  order: 50,
  tools: {
    firestore_simulate_rules: 'read',
    firestore_rules_stdlib_list: 'read',
    firestore_rules_stdlib_get: 'read',
    firestore_lint_rules: 'read',
    firestore_resolve_modules: 'read',
    rules_stdlib_list: 'read',
    rules_stdlib_get: 'read',
    rules_resolve_modules: 'read',
  },
} as const satisfies ToolFamilyRecord;
