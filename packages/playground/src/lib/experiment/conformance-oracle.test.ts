/**
 * Unit tests for the held-out conformance oracle. Runs the REAL Firestore
 * simulator over known rulesets — no LLM, no network, no spend.
 */
import { describe, test, expect } from 'bun:test';
import {
  conformanceSpec,
  extractFinalRules,
  CONFORMANCE_SPEC_NAME,
  type ConformanceCase,
} from './conformance-oracle';
import type { RunSnapshot } from '@inbrowser/agent';

const OWNER_READ_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
  }
}`;

const PUBLIC_READ_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if true;
    }
  }
}`;

const OWNER_READ_CASES: ConformanceCase[] = [
  { method: 'get', path: 'users/alice', auth: { uid: 'alice' }, expect: 'ALLOW' },
  { method: 'get', path: 'users/alice', auth: { uid: 'mallory' }, expect: 'DENY' },
  { method: 'get', path: 'users/alice', auth: null, expect: 'DENY' },
];

function snapshotWithRules(rules: string, assistantText = ''): RunSnapshot {
  return {
    finalWorkspace: { rules },
    finalRuntime: {},
    assistantText,
    trace: [],
  } as unknown as RunSnapshot;
}

describe('conformance oracle', () => {
  test('spec name is stable', () => {
    expect(CONFORMANCE_SPEC_NAME).toBe('experiment/conformance');
  });

  test('passes when every held-out case holds', () => {
    const r = conformanceSpec(snapshotWithRules(OWNER_READ_RULES), { cases: OWNER_READ_CASES });
    expect(r.ok).toBe(true);
    expect((r.detail as { passed: number }).passed).toBe(3);
  });

  test('fails and reports the offending case for an over-permissive ruleset', () => {
    const r = conformanceSpec(snapshotWithRules(PUBLIC_READ_RULES), { cases: OWNER_READ_CASES });
    expect(r.ok).toBe(false);
    const failures = (r.detail as { failures: Array<{ auth?: unknown; got: string }> }).failures;
    // The two DENY cases (other user, unauthenticated) now wrongly ALLOW.
    expect(failures.length).toBe(2);
    expect(failures.every((f) => f.got === 'ALLOW')).toBe(true);
  });

  test('errors cleanly when no ruleset was produced', () => {
    const r = conformanceSpec(snapshotWithRules(''), { cases: OWNER_READ_CASES });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no ruleset');
  });

  test('errors when no cases supplied', () => {
    const r = conformanceSpec(snapshotWithRules(OWNER_READ_RULES), { cases: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('no cases');
  });

  test('extractFinalRules falls back to the assistant text fence (draft-validate path)', () => {
    const text = `Here are the rules:\n\`\`\`firestore\n${OWNER_READ_RULES}\n\`\`\``;
    const snap = snapshotWithRules('', text); // empty workspace rules
    const rules = extractFinalRules(snap);
    expect(rules).toContain('rules_version');
    // And grading via the fallback path still works:
    const r = conformanceSpec(snap, { cases: OWNER_READ_CASES });
    expect(r.ok).toBe(true);
  });
});
