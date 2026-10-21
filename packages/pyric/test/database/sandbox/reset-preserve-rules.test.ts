import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import { getDatabase, ref, onValue, set } from '../../../src/database/index.js';
import { getActiveRules, setRules } from '../../../src/database/sandbox-controls.js';
import { withDatabaseRulesPreservedOnReset } from '../../../src/sandbox/internal/index.js';

describe('resetAll inside withDatabaseRulesPreservedOnReset', () => {
  it('keeps RTDB rules and allowed onValue listener gets [initial, null] and no cancel; plain resetAll clears rules', async () => {
    // Plain resetAll clears rules
    {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox);
      setRules(db, { rules: { '.read': true, '.write': true } });
      await sandbox.resetAll();
      expect(getActiveRules(db)).toBeNull();
    }

    // Inside withDatabaseRulesPreservedOnReset keeps rules
    {
      const sandbox = initializeSandbox();
      const db = getDatabase(sandbox);
      setRules(db, { rules: { '.read': true, '.write': true } });
      await set(ref(db, 'a'), 1);

      const events: unknown[] = [];
      let cancelCount = 0;
      const unsub = onValue(
        ref(db, 'a'),
        (snap) => events.push(snap.val()),
        () => { cancelCount++; }
      );

      // wait for initial value
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(events).toEqual([1]);
      expect(cancelCount).toBe(0);

      await withDatabaseRulesPreservedOnReset(sandbox, async () => {
        await sandbox.resetAll();
      });

      // Rules are preserved
      expect(getActiveRules(db)).not.toBeNull();

      // Listener gets null and is not canceled
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(events).toEqual([1, null]);
      expect(cancelCount).toBe(0);

      unsub();
    }
  });
});
