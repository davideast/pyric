/**
 * Regression pins for the auth-UI guidance (user-found, 2026-06-10):
 * generated apps kept rendering developer identity-switchers ("sign in
 * as Alice/Bob/Admin" button rows) because three prompt layers either
 * recommended or under-specified identity handling. With the sign-in
 * helper + Auth tab owning identities, the in-app switcher is an
 * anti-pattern — these tests pin the guidance that forbids it at every
 * layer that previously induced it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSystemPrompt } from './system-prompt';
import { ENHANCER_SYSTEM_PROMPT } from './prompt-enhancer/system-prompt';

describe('agent system prompt — auth UI guidance', () => {
  const prompt = buildSystemPrompt({ diagnosticsEnabled: false });

  test('forbids developer identity-switchers in app UI', () => {
    expect(prompt).toContain('NEVER render a developer identity-switcher');
    expect(prompt).toContain('no uid dropdowns');
    expect(prompt).toContain('no hardcoded test credentials');
  });

  test('teaches that the HOST owns test identities (helper + Auth tab)', () => {
    expect(prompt).toContain('sign-in helper');
    expect(prompt).toContain('Auth tab');
    expect(prompt).toContain('signing out and signing back in');
  });

  test('scopes withAuth to sandbox/tool contexts, never App.tsx', () => {
    expect(prompt).toContain('SANDBOX/TOOL contexts only');
    expect(prompt).toContain('NEVER in App.tsx');
  });
});

describe('prompt enhancer — auth phrasing guidance', () => {
  test('switchers are forbidden WITHOUT teaching host behavior', () => {
    // The prohibition stays…
    expect(ENHANCER_SYSTEM_PROMPT).toContain('NEVER ask for an in-app identity switcher');
    // …but the old host-behavior lecture is deliberately GONE: phrases
    // like "signing out and signing back in" leaked into enhanced
    // prompts and then into generated app UI. Host knowledge lives in
    // the MAIN agent prompt (asserted above), never in the enhancer.
    // Full forbidden-vocabulary pin: prompt-enhancer/system-prompt.test.ts.
    expect(ENHANCER_SYSTEM_PROMPT).not.toContain('signing out and signing back in');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('DOMAIN PURITY');
  });

  test('stale probe-script framing is gone', () => {
    expect(ENHANCER_SYSTEM_PROMPT).not.toContain('JS probe script');
  });
});

describe('playground-prompts skill — source of truth stays in sync', () => {
  test('the view-as-another-user recommendation is gone, replaced by multi-role flows', () => {
    const skill = readFileSync(
      resolve(import.meta.dir, '../../../../../.agents/skills/playground-prompts/SKILL.md'),
      'utf8',
    );
    expect(skill).not.toContain('view as another user');
    expect(skill).not.toContain('moderator-impersonation');
    expect(skill).toContain('Multi-role flows');
    expect(skill).toContain('NEVER prompt for an in-app identity switcher');
  });
});
