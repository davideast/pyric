import { describe, expect, test } from 'bun:test';
import type { SkillDefinition } from '~/lib/skills/registry';
import { summarizeAgentMode } from './AgentModeControl';

const APP_SKILL: SkillDefinition = {
  id: 'game-rules',
  label: 'Game rules',
  icon: 'stadia_controller',
  description: 'Build game rules',
  brief: 'brief',
  manTopic: 'game-rules',
  manSummary: 'summary',
  manBody: 'body',
};

const TOOLING_SKILL: SkillDefinition = {
  id: 'firestore-rules-audit',
  label: 'Firestore rules audit',
  icon: 'policy',
  description: 'Audit Firestore rules',
  brief: 'brief',
  manTopic: 'firestore-rules-audit',
  manSummary: 'summary',
  manBody: 'body',
  promptProfile: 'firebase-tooling',
};

describe('summarizeAgentMode', () => {
  test('shows default mode when no skills are active', () => {
    expect(summarizeAgentMode([])).toMatchObject({
      label: 'Default',
      detail: 'App builder',
      activeCount: 0,
      promptProfile: 'app-builder',
    });
  });

  test('uses the single active skill as the visible mode', () => {
    expect(summarizeAgentMode([APP_SKILL])).toMatchObject({
      icon: 'stadia_controller',
      label: 'Game rules',
      detail: 'App builder',
      activeCount: 1,
      promptProfile: 'app-builder',
    });
  });

  test('collapses multiple tooling skills to one profile summary', () => {
    expect(summarizeAgentMode([APP_SKILL, TOOLING_SKILL])).toMatchObject({
      label: 'Firebase tooling',
      detail: '2 skills active',
      activeCount: 2,
      promptProfile: 'firebase-tooling',
    });
  });
});
