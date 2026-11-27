/**
 * Regression tests for getAfter() batch sibling-merge semantics (#1759).
 *
 * Production Firestore evaluates getAfter() against the post-batch projected
 * document state (verified against live Firestore in
 * rules-firestore-atomic-batch-sibling-merge.json). These tests pin the
 * field-mask merge boundaries across batch update, dot-path update, set with
 * merge, wholesale map replacement, and rollback on rule denial.
 */
import { describe, expect, test } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';

const SIBLING_MERGE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /auditLogs/{logId} {
      allow create: if request.auth != null
                    && getAfter(/databases/$(database)/documents/config/state).data.role == 'admin'
                    && getAfter(/databases/$(database)/documents/config/state).data.modified == true;
    }
    match /config/{docId} {
      allow update: if request.auth != null;
    }
  }
}`;

describe('getAfter batch sibling-merge semantics (#1759)', () => {
  test('ALLOWS batch create when sibling update preserves untouched pre-existing field and updates target field', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: SIBLING_MERGE_RULES,
      documents: { 'config/state': { role: 'admin', modified: false } },
    });

    const result = env.batch([
      { method: 'update', path: 'config/state', data: { modified: true } },
      { method: 'create', path: 'auditLogs/log1', data: { action: 'update_config' } },
    ], { uid: 'verifier' });

    expect(result.allowed).toBe(true);
    expect(env.getDocument('config/state')).toEqual({ role: 'admin', modified: true });
    expect(env.getDocument('auditLogs/log1')).toEqual({ action: 'update_config' });
  });

  test('DENIES solo create when config/state has not been updated in a batch (fail-closed control)', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: SIBLING_MERGE_RULES,
      documents: { 'config/state': { role: 'admin', modified: false } },
    });

    const result = env.execute({
      method: 'create',
      path: 'auditLogs/log1',
      data: { action: 'update_config' },
      auth: { uid: 'verifier' },
    });

    expect(result.allowed).toBe(false);
    expect(env.getDocument('auditLogs/log1')).toBe(null);
  });

  test('DENIES and rolls back batch when sibling update overwrites pre-existing field to non-admin', () => {
    const env = new LocalEnvironment();
    env.seed({
      rules: SIBLING_MERGE_RULES,
      documents: { 'config/state': { role: 'admin', modified: false } },
    });

    const result = env.batch([
      { method: 'update', path: 'config/state', data: { role: 'viewer', modified: true } },
      { method: 'create', path: 'auditLogs/log1', data: { action: 'update_config' } },
    ], { uid: 'verifier' });

    expect(result.allowed).toBe(false);
    expect(env.getDocument('config/state')).toEqual({ role: 'admin', modified: false });
    expect(env.getDocument('auditLogs/log1')).toBe(null);
  });

  test('update with non-dot nested map replaces nested map wholesale in getAfter (does not fail open on dropped sibling)', () => {
    const nestedRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /auditLogs/{logId} {
      allow create: if getAfter(/databases/$(database)/documents/config/state).data.meta.role == 'admin'
                    && getAfter(/databases/$(database)/documents/config/state).data.meta.modified == true;
    }
    match /config/{docId} {
      allow update: if true;
    }
  }
}`;
    // Wholesale map update replaces `meta`, dropping `meta.role`.
    const wholesaleEnv = new LocalEnvironment();
    wholesaleEnv.seed({
      rules: nestedRules,
      documents: { 'config/state': { meta: { role: 'admin', modified: false } } },
    });
    const wholesale = wholesaleEnv.batch([
      { method: 'update', path: 'config/state', data: { meta: { modified: true } } },
      { method: 'create', path: 'auditLogs/log1', data: {} },
    ], { uid: 'verifier' });
    expect(wholesale.allowed).toBe(false);
    expect(wholesaleEnv.getDocument('config/state')).toEqual({ meta: { role: 'admin', modified: false } });

    // Dot-path update patches only `meta.modified`, preserving `meta.role`.
    const dotPathEnv = new LocalEnvironment();
    dotPathEnv.seed({
      rules: nestedRules,
      documents: { 'config/state': { meta: { role: 'admin', modified: false } } },
    });
    const dotPath = dotPathEnv.batch([
      { method: 'update', path: 'config/state', data: { 'meta.modified': true } },
      { method: 'create', path: 'auditLogs/log1', data: {} },
    ], { uid: 'verifier' });
    expect(dotPath.allowed).toBe(true);
    expect(dotPathEnv.getDocument('config/state')).toEqual({ meta: { role: 'admin', modified: true } });
  });

  test('set with merge:true deep-merges nested fields for getAfter while plain set replaces wholesale', () => {
    const mergeRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /auditLogs/{logId} {
      allow create: if getAfter(/databases/$(database)/documents/config/state).data.meta.role == 'admin'
                    && getAfter(/databases/$(database)/documents/config/state).data.meta.modified == true;
    }
    match /config/{docId} {
      allow update: if true;
    }
  }
}`;
    const mergeEnv = new LocalEnvironment();
    mergeEnv.seed({
      rules: mergeRules,
      documents: { 'config/state': { meta: { role: 'admin', modified: false } } },
    });
    const merged = mergeEnv.batch([
      { method: 'set', path: 'config/state', data: { meta: { modified: true } }, merge: true },
      { method: 'create', path: 'auditLogs/log1', data: {} },
    ], { uid: 'verifier' });
    expect(merged.allowed).toBe(true);

    const replaceEnv = new LocalEnvironment();
    replaceEnv.seed({
      rules: mergeRules,
      documents: { 'config/state': { meta: { role: 'admin', modified: false } } },
    });
    const replaced = replaceEnv.batch([
      { method: 'set', path: 'config/state', data: { meta: { modified: true } } },
      { method: 'create', path: 'auditLogs/log1', data: {} },
    ], { uid: 'verifier' });
    expect(replaced.allowed).toBe(false);
  });
});
