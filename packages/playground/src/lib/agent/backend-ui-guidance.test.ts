/**
 * Regression pins for the no-in-app-backend guidance (SF-S1, the #575
 * identity-switcher lesson generalized). The first live app-building run that
 * exposed this bug baked a client-side `setDoc(menuItems)` seed button into
 * App.tsx because the prompt did not clearly name the host seed surface.
 * The fix is to give the ReAct loop the seed tool and forbid in-app
 * backend/seed/admin code in protected prompt guidance.
 *
 * `BACKEND_UI_GUIDANCE` is the ONE source of truth: the react loop inherits
 * it via `buildSystemPrompt`. These tests pin the load-bearing strings so the
 * remaining agent loop cannot silently drop the rule.
 */
import { describe, expect, test } from 'bun:test';
import { BACKEND_UI_GUIDANCE, FIRESTORE_SEEDING_POLICY, buildSystemPrompt } from './system-prompt';

// The load-bearing strings — asserted verbatim against every prompt the
// guidance feeds. Keep in sync with BACKEND_UI_GUIDANCE in system-prompt.ts.
const PINS = [
  'NO IN-APP BACKEND/SEED/ADMIN CODE',
  "The app UI renders the END-USER's product ONLY",
  'Apps NEVER write fixture/seed/admin data',
  'no client-side seeding',
  'no `setDoc`/`addDoc` to populate demo data',
  'no admin bootstrap',
  'Seeding, identity setup, and fixture data are HOST surfaces',
  'CALL `seed_firestore_data_as_admin`',
  'A seed button in App.tsx is a security smell',
] as const;

describe('backend-UI guidance — single source of truth', () => {
  test('BACKEND_UI_GUIDANCE carries every pinned string', () => {
    for (const pin of PINS) expect(BACKEND_UI_GUIDANCE).toContain(pin);
  });
});

describe('react loop inherits the guidance (buildSystemPrompt)', () => {
  const prompt = buildSystemPrompt({
    diagnosticsEnabled: false,
    prompt: 'Build a menu ordering app with Firestore rules',
  });

  test('forbids in-app seeding / admin code', () => {
    for (const pin of PINS) expect(prompt).toContain(pin);
  });

  test('the whole guidance block is present verbatim', () => {
    expect(prompt).toContain(BACKEND_UI_GUIDANCE);
  });
});

describe('react loop carries the Firestore seed ID policy', () => {
  const prompt = buildSystemPrompt({
    diagnosticsEnabled: false,
    prompt: 'Build a menu ordering app with Firestore rules',
  });

  test('points the agent at the host seed tool, not in-app UI', () => {
    expect(prompt).toContain('seed_firestore_data_as_admin');
    expect(prompt).toContain('Apps NEVER write fixture/seed/admin data');
    expect(prompt).toContain('A seed button in App.tsx is a security smell');
  });

  test('carries the Firestore seed ID policy', () => {
    expect(prompt).toContain(FIRESTORE_SEEDING_POLICY);
    expect(prompt).toContain('Use `autoId: true` for addDoc-style user-created docs');
    expect(prompt).toContain('Use explicit IDs for semantic or stable docs');
    expect(prompt).toContain('test-file `seed` blocks');
  });
});
