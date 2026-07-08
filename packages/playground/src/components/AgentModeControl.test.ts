import { describe, expect, test } from 'bun:test';
import type { SkillDefinition } from '~/lib/skills/registry';
import { shouldShowSkillSearch, summarizeAgentMode } from './AgentModeControl';

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
  promptProfile: 'firebase',
};

describe('summarizeAgentMode', () => {
  test('shows default mode when no skills are active', () => {
    expect(summarizeAgentMode([])).toMatchObject({
      icon: 'build',
      label: 'Skills',
      detail: '',
      activeCount: 0,
    });
  });

  test('shows the single active specialist in the compact selector', () => {
    expect(summarizeAgentMode([APP_SKILL])).toMatchObject({
      icon: 'stadia_controller',
      label: 'Game rules',
      detail: '',
      activeCount: 1,
    });
  });

  test('collapses multiple specialist skills to one summary', () => {
    expect(summarizeAgentMode([APP_SKILL, TOOLING_SKILL])).toMatchObject({
      icon: 'build',
      label: '2 skills',
      detail: '',
      activeCount: 2,
    });
  });
});

describe('shouldShowSkillSearch', () => {
  test('keeps search hidden until the specialist list is long enough', () => {
    expect(shouldShowSkillSearch([APP_SKILL, TOOLING_SKILL])).toBe(false);
    expect(
      shouldShowSkillSearch([
        APP_SKILL,
        TOOLING_SKILL,
        { ...APP_SKILL, id: 'a' },
        { ...APP_SKILL, id: 'b' },
        { ...APP_SKILL, id: 'c' },
      ]),
    ).toBe(false);
    expect(
      shouldShowSkillSearch([
        APP_SKILL,
        TOOLING_SKILL,
        { ...APP_SKILL, id: 'a' },
        { ...APP_SKILL, id: 'b' },
        { ...APP_SKILL, id: 'c' },
        { ...APP_SKILL, id: 'd' },
      ]),
    ).toBe(true);
  });
});
