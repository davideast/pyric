import type { ToolFamilyRecord } from '../tool-families.js';
export default {
  transport: 'in-process',
  order: 50,
  tools: [
    'firestore_simulate_rules',
    'firestore_rules_stdlib_list',
    'firestore_rules_stdlib_get',
    'firestore_lint_rules',
    'firestore_resolve_modules',
    'rules_stdlib_list',
    'rules_stdlib_get',
    'rules_resolve_modules',
  ],
} as const satisfies ToolFamilyRecord;
