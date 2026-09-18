import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { get, getDatabase, ref } from '../../src/database/index.js';
import { getActiveRules, setRules } from '../../src/database/sandbox-controls.js';

describe('RTDB rules after reset', () => {
  for (const operation of ['reset', 'resetAll'] as const) {
    it(`${operation} clears rules and returns existing handles to the default policy`, async () => {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox);
      const target = ref(db, 'notes');
      setRules(db, { rules: { '.read': true, '.write': true } });
      expect((await get(target)).exists()).toBe(false);

      await sandbox[operation]();

      expect(getActiveRules(db)).toBeNull();
      await expect(get(target)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });
  }
});
