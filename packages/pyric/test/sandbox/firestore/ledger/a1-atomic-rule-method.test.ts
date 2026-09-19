/**
 * Ledger A1: batch and transaction writes evaluate the rule for the method
 * the caller used. The evaluated method must not be derived from the batch
 * projection, because an `update` on a missing document projects to null
 * and would otherwise be evaluated as a `delete`.
 *
 * Expected production behavior: rules run for the caller's method; when
 * rules allow, the existence precondition decides between `not-found` and
 * `already-exists`.
 */
import { describe, expect, it } from 'bun:test';
import { LocalEnvironment } from '../../../../src/sandbox/internal/index.js';

const RULES = `rules_version = '2';
service cloud.firestore { match /databases/{db}/documents {
  match /a/{id} { allow create: if false; allow update: if true; allow delete: if true; }
  match /b/{id} { allow create: if true; allow update: if false; allow delete: if false; }
  match /c/{id} { allow create: if false; allow update: if false; allow delete: if true; }
} }`;

function environment(): LocalEnvironment {
  const env = new LocalEnvironment();
  env.seed({ rules: RULES, documents: { 'b/1': { x: 1 }, 'c/1': { x: 1 } } });
  return env;
}

function evidence(messages: readonly string[] | undefined): string {
  return (messages ?? []).join('\n');
}

describe('ledger A1: atomic writes evaluate the caller\'s rule method', () => {
  it('batch update on a missing document evaluates the update rule and reports not-found', () => {
    const result = environment().batch([{ method: 'update', path: 'a/missing', data: { x: 2 } }], { uid: 'u' });
    const text = evidence(result.results[0]?.debugMessages);
    expect(text).toContain('(update)');
    expect(text).not.toContain('(delete)');
    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('not-found');
  });

  it('batch create on an existing document evaluates the create rule and reports already-exists', () => {
    const result = environment().batch([{ method: 'create', path: 'b/1', data: { x: 2 } }], { uid: 'u' });
    const text = evidence(result.results[0]?.debugMessages);
    expect(text).toContain('(create)');
    expect(text).not.toContain('(update)');
    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('already-exists');
  });

  it('batch delete on an existing document evaluates the delete rule', () => {
    const result = environment().batch([{ method: 'delete', path: 'c/1' }], { uid: 'u' });
    const text = evidence(result.results[0]?.debugMessages);
    expect(text).toContain('(delete)');
    expect(result.allowed).toBe(true);
  });

  it('transaction update on a missing document reports method update and not-found', () => {
    const result = environment().transaction((tx) => { tx.update('a/missing', { x: 2 }); }, { auth: { uid: 'u' } });
    expect(result.writes[0]?.method).toBe('update');
    expect(evidence(result.writes[0]?.debugMessages)).not.toContain('(delete)');
    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('not-found');
  });

  it('transaction create on an existing document reports method create and already-exists', () => {
    const result = environment().transaction((tx) => { tx.create('b/1', { x: 2 }); }, { auth: { uid: 'u' } });
    expect(result.writes[0]?.method).toBe('create');
    expect(result.allowed).toBe(false);
    expect(result.error?.code).toBe('already-exists');
  });
});
