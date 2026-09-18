/**
 * Ledger A2: `sandbox.reset()` clears Realtime Database rules along with
 * data. Rules set in one session must not survive into the reset session.
 */
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from '../../../src/sandbox/index.js';
import { getDatabase } from '../../../src/database/index.js';
import { getActiveRules, setRules } from '../../../src/database/sandbox-controls.js';

describe('ledger A2: reset clears RTDB rules', () => {
  it('rules are absent after sandbox.reset()', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    setRules(db, { rules: { '.read': false, '.write': false } });
    expect(getActiveRules(db)).not.toBeNull();
    sandbox.reset();
    expect(getActiveRules(getDatabase(sandbox))).toBeNull();
  });
});
