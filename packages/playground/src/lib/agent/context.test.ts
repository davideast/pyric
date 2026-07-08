import { describe, expect, test } from 'bun:test';
import {
  detectContextLensIds,
  detectContextSignalMatches,
  resolveAgentContext,
  suggestedSkillIdsForPrompt,
} from './context';

describe('resolveAgentContext', () => {
  test('defaults to Firebase expert context', () => {
    const context = resolveAgentContext();
    expect(context.promptProfile).toBe('firebase');
    expect(context.workbenchIntent).toMatchObject({
      promptProfile: 'firebase',
      primarySurface: 'firebase',
      defaultFirebaseSubtab: 'sandbox',
      toolProfilePreference: 'diagnostic',
      strategyPreference: 'react',
    });
  });

  test('app intent opts into app-builder context', () => {
    const context = resolveAgentContext({
      prompt: 'Build a Kanban app with Firestore rules',
    });
    expect(context.promptProfile).toBe('app-builder');
    expect(context.lenses.map((lens) => lens.id)).toContain('app-build');
    expect(context.workbenchIntent.primarySurface).toBe('preview');
  });

  test('Firestore data-modeling prompt stays Firebase-native', () => {
    const context = resolveAgentContext({
      prompt: 'Model Firestore data for teams with role based access',
    });
    expect(context.promptProfile).toBe('firebase');
    expect(context.lenses.map((lens) => lens.id)).toEqual(
      expect.arrayContaining(['firestore', 'auth', 'rules', 'data-modeling']),
    );
    expect(context.workbenchIntent.primarySurface).not.toBe('preview');
  });

  test('dismissed lenses are excluded for the current prompt', () => {
    expect(detectContextLensIds('Audit Firestore security rules')).toContain('audit');
    expect(detectContextLensIds('Audit Firestore security rules', ['audit'])).not.toContain(
      'audit',
    );
  });

  test('detects non-overlapping signal matches for composer highlights', () => {
    const matches = detectContextSignalMatches(
      'Write a Firestore data model that uses role based access',
    );
    expect(matches.map((match) => [match.lensId, match.label])).toEqual([
      ['firestore', 'Firestore'],
      ['data-modeling', 'data model'],
      ['rules', 'role based access'],
    ]);
    expect(matches.every((match, index) => index === 0 || match.start >= matches[index - 1]!.end)).toBe(
      true,
    );
  });

  test('specialist phrases suggest but do not enable niche skills', () => {
    const context = resolveAgentContext({
      prompt: 'Design turn-based multiplayer game rules',
    });
    expect(suggestedSkillIdsForPrompt('turn based multiplayer game')).toContain('game-rules');
    expect(context.suggestedSkillIds).toContain('game-rules');
    expect(context.activeSkills.map((skill) => skill.id)).not.toContain('game-rules');
  });

  test('game specialist suggestion avoids generic board/product language', () => {
    expect(
      suggestedSkillIdsForPrompt('Create a Firestore data model for a kanban board'),
    ).not.toContain('game-rules');
    expect(
      suggestedSkillIdsForPrompt('Create a Firestore data model that uses role based access'),
    ).not.toContain('game-rules');
    expect(suggestedSkillIdsForPrompt('Model team membership for a project board')).not.toContain(
      'game-rules',
    );
    expect(suggestedSkillIdsForPrompt('Design a multiplayer game with valid moves')).toContain(
      'game-rules',
    );
    expect(suggestedSkillIdsForPrompt('Write rules for a chess lobby')).toContain('game-rules');
  });
});
