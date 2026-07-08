/**
 * Enhancer prompt — domain purity + shape guards.
 *
 * The enhanced prompt is USER-VISIBLE text that becomes the agent's
 * build brief; host/sandbox vocabulary in the enhancer's instructions
 * historically leaked into enhanced prompts and then into generated
 * app UI (identity switchers, references to host tabs). These tests
 * pin the instruction text itself: no host vocabulary, purity rules
 * present, and Firebase-native shaping by default.
 */
import { describe, expect, test } from 'bun:test';
import { buildEnhancerPrompt, ENHANCER_SYSTEM_PROMPT } from './system-prompt';
import {
  firebaseAuditSkill,
  playgroundFirebaseAuthModelSkill,
  playgroundFirestoreQueryIndexesSkill,
} from '~/lib/skills/firebase-tooling';
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

  test('defaults to a Firebase-native shape', () => {
    expect(ENHANCER_SYSTEM_PROMPT).toContain('FIREBASE EXPERT IS ALWAYS ON');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('A well-shaped Firebase prompt states');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('rules, seed docs, Auth users');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('No app UI unless the user explicitly asks');
    expect(ENHANCER_SYSTEM_PROMPT).not.toContain('two collections');
  });

  test('keeps the output discipline', () => {
    expect(ENHANCER_SYSTEM_PROMPT).toContain('Output ONLY the enhanced prompt');
    expect(ENHANCER_SYSTEM_PROMPT).toContain('30–70 words');
  });

  test('keeps internal seed tool names out of user-visible enhancement guidance', () => {
    expect(ENHANCER_SYSTEM_PROMPT).toContain('seed data');
    expect(ENHANCER_SYSTEM_PROMPT).not.toContain('seed_firestore_data_as_admin');
    expect(ENHANCER_SYSTEM_PROMPT).not.toContain('autoId');
  });
});

describe('buildEnhancerPrompt — skill-aware shapes (P4)', () => {
  test('active game skill adds an overlay without replacing Firebase Expert guidance', () => {
    const p = buildEnhancerPrompt(
      [firestoreGameRulesSkill],
      'Create a Firestore data structure for a Connect Four game that prevents cheating',
    );
    expect(p).toContain('FIREBASE EXPERT IS ALWAYS ON');
    expect(p).toContain('Shape this as a Firestore data modeling request');
    expect(p).toContain('Active specialist skill: "Game rules"');
    expect(p).toContain('Firebase Expert stays on');
    expect(p).toContain('anti-cheat boundary');
    expect(p).not.toContain('shape EVERY idea');
    expect(p).not.toContain('If the idea is a GAME');
    // Purity + discipline survive in every composition.
    expect(p).toContain('DOMAIN PURITY');
    expect(p).toContain('Output ONLY the enhanced prompt');
    expect(p).not.toContain('Auth tab');
  });

  test('legacy general Firebase audit skill resolves into lenses, not replacement blocks', () => {
    const p = buildEnhancerPrompt([firebaseAuditSkill]);
    expect(p).toContain('FIREBASE EXPERT IS ALWAYS ON');
    expect(p).toContain('Shape this as a rules audit request');
    expect(p).not.toContain('The user activated');
    expect(p).not.toContain('Active specialist skill');
    expect(p).not.toContain('two collections');
    expect(p).not.toContain('If the idea is a GAME');
  });

  test('legacy Firebase Auth model skill shapes auth/rules requests through lenses', () => {
    const p = buildEnhancerPrompt([playgroundFirebaseAuthModelSkill]);
    expect(p).toContain('Shape this as a Firebase Auth modeling request');
    expect(p).toContain('custom claims');
    expect(p).not.toContain('The user activated');
    expect(p).not.toContain('two collections');
  });

  test('legacy Firestore query/index skill shapes query proof requests through lenses', () => {
    const p = buildEnhancerPrompt([playgroundFirestoreQueryIndexesSkill]);
    expect(p).toContain('Shape this as a Firestore query/index design request');
    expect(p).toContain('index extraction');
    expect(p).not.toContain('The user activated');
    expect(p).not.toContain('two collections');
  });

  test('no active skills = the pinned Firebase-native default', () => {
    expect(buildEnhancerPrompt([])).toBe(ENHANCER_SYSTEM_PROMPT);
  });

  test('app-build prompts opt into the app shape and game gate', () => {
    const p = buildEnhancerPrompt([], 'Build a turn-based game app with Firestore rules');
    expect(p).toContain('If the idea is a GAME');
    expect(p).toContain(firestoreGameRulesSkill.enhancerShape!);
    expect(p).toContain('two collections');
  });

  test('Firestore data modeling prompts use rules-first shape', () => {
    const p = buildEnhancerPrompt([], 'Model Firestore data for teams with role based access');
    expect(p).toContain('Shape this as a Firestore data modeling request');
    expect(p).toContain('Start from the security rules boundary first');
    expect(p).toContain('one allowed and one denied proof');
    expect(p).not.toContain('two collections');
  });
});
