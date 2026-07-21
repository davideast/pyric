/** Bare-call functions reserved by the Firebase Rules language. */
export const RULES_BUILTIN_FUNCTIONS: ReadonlySet<string> = new Set([
  'get',
  'exists',
  'getAfter',
  'debug',
]);
