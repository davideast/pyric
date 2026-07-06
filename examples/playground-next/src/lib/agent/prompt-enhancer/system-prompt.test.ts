/**
 * Enhancer prompt — domain purity + shape guards.
 *
 * The enhanced prompt is USER-VISIBLE text that becomes the agent's
 * build brief; host/sandbox vocabulary in the enhancer's instructions
 * historically leaked into enhanced prompts and then into generated
 * app UI (identity switchers, references to host tabs). These tests
 * pin the instruction text itself: no host vocabulary, purity rules
 * present, and a game shape distinct from the CRUD-app shape.
 */
import { describe, expect, test } from 'bun:test';
import { buildEnhancerPrompt, ENHANCER_SYSTEM_PROMPT } from './system-prompt';
import { firestoreGameRulesSkill } from '~/lib/skills/firestore-game-rules';

describe('ENHANCER_SYSTEM_PROMPT domain purity', () => {
  test('never teaches the model host/sandbox UI behavior', () => {
    // Forbidden: host-behavior vocabulary that previously leaked into
    // enhanced prompts. The prompt may FORBID mentioning some of these
    // (e.g. "NEVER mention the playground") — so we assert the
    // *descriptive* phrases are gone, not the words inside NEVER rules.
    const forbidden = [
      'account picker',
      'Auth tab',
      'signing out and signing back in',
      'managed by the host',
      'signInWithPopup', // API names belong to the agent, not the prompt text
      'custom claim)',
    ];
    for (const phrase of forbidden) {
      expect(ENHANCER_SYSTEM_PROMPT).not.toContain(phrase);
    }
  });

  test('carries the purity rules', () => {
    expect(ENHANCER_SYSTEM_PROMPT).toContain('DOMAIN PURITY');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('NEVER mention the playground');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('identity switcher');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('with Google sign-in');
  });

  test('has a game shape distinct from the CRUD-app shape', () => {
    expect(ENHANCER_SYSTEM_PROMPT).toContain('If the idea is a GAME');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('anti-cheat boundary');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('attempting an illegal move');
    // The CRUD shape stays for non-game ideas.
    expect(ENHANCER_SYSTEM_PROMPT).toContain('two collections');
  });

  test('keeps the output discipline', () => {
    expect(ENHANCER_SYSTEM_PROMPT).toContain('Output ONLY the enhanced prompt');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('30–50 words');
  });
});

describe('buildEnhancerPrompt — skill-aware shapes (P4)', () => {
  test('active game skill takes over the shape section', () => {
    const p = buildEnhancerPrompt([firestoreGameRulesSkill]);
    expect(p).toContain('The user activated the "Game rules" skill');
    expect(p).toContain('anti-cheat boundary');
    // The default app shape and the conditional game gate are replaced.
    expect(p).not.toContain('two collections');
    expect(p).not.toContain('If the idea is a GAME');
    // Purity + discipline survive in every composition.
    expect(p).toContain('DOMAIN PURITY');
    expect(p).toContain('Output ONLY the enhanced prompt');
    expect(p).not.toContain('Auth tab');
  });

  test('no active skills = the pinned default (single source of the game shape)', () => {
    expect(buildEnhancerPrompt([])).toBe(ENHANCER_SYSTEM_PROMPT);
    // The default's game gate reuses the skill's shape VERBATIM — no drift.
    expect(ENHANCER_SYSTEM_PROMPT).toContain(firestoreGameRulesSkill.enhancerShape!);
  });
});
