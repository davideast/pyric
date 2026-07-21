import { describe, expect, test } from 'bun:test';
import {
  incompatibleStdlibExport,
  STDLIB_SERVICE_CONTRACT_MODULES,
} from '../../../src/rules/modules/stdlib-service-compatibility.js';

describe('stdlib service compatibility', () => {
  test('admits common modules in Storage', () => {
    expect(incompatibleStdlibExport('firebase.storage', 'auth', 'isAuthenticated')).toBeNull();
    expect(incompatibleStdlibExport('firebase.storage', 'membership', 'hasRole')).toBeNull();
  });

  test('rejects Firestore-only modules in Storage', () => {
    expect(incompatibleStdlibExport('firebase.storage', 'lifecycle', 'immutableFields')).toBe(
      "Function 'immutableFields' from module 'lifecycle' is not compatible with service 'firebase.storage'",
    );
  });

  test('exports the generated module inventory', () => {
    expect(STDLIB_SERVICE_CONTRACT_MODULES).toContain('auth');
    expect(STDLIB_SERVICE_CONTRACT_MODULES).toContain('lifecycle');
  });
});
