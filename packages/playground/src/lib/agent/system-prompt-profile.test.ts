import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildClaudeLanePrompt } from './claude-lane-prompt';
import { buildSystemPrompt } from './system-prompt';
import { __setSkillsForTest, type SkillDefinition } from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';
import { useWorkspaceStore } from '~/lib/store/workspace';

const TOOLING_SKILL: SkillDefinition = {
  id: 'fixture-tooling',
  label: 'Fixture tooling',
  icon: 'policy',
  description: 'test-only Firebase tooling skill',
  brief: 'FIXTURE TOOLING BRIEF',
  manTopic: 'fixture-tooling',
  manSummary: 'fixture tooling one-line summary',
  manBody: 'fixture tooling body',
  promptProfile: 'firebase-tooling',
  primarySurface: 'firebase',
  defaultFirebaseSubtab: 'sandbox',
};

function resetWorkspace() {
  const ws = useWorkspaceStore.getState();
  ws.setRules('');
  ws.setDatabaseRules('');
  ws.setAppSource('');
}

beforeEach(() => {
  __setSkillsForTest([TOOLING_SKILL]);
  useSkillsStore.getState().clear();
  resetWorkspace();
});

afterEach(() => {
  __setSkillsForTest(null);
  useSkillsStore.getState().clear();
  resetWorkspace();
});

describe('system prompt profiles', () => {
  test('default app-builder prompt keeps the app workflow', () => {
    const prompt = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(prompt).toContain('BUILD App.tsx last');
    expect(prompt).toContain('UI STYLE');
    expect(prompt).toContain('NO IN-APP BACKEND/SEED/ADMIN CODE');
  });

  test('Firebase tooling prompt replaces app-building guidance', () => {
    useSkillsStore.getState().toggleSkill('fixture-tooling');
    const prompt = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(prompt).toContain('FIREBASE TOOLING MODE');
    expect(prompt).toContain('Do NOT create or edit `/workspace/src/App.tsx`');
    expect(prompt).toContain('rules, workspace tests, seed data, Auth users');
    expect(prompt).not.toContain('BUILD App.tsx last');
    expect(prompt).not.toContain('UI STYLE');
    expect(prompt).not.toContain('NO IN-APP BACKEND/SEED/ADMIN CODE');
  });

  test('fresh Firebase tooling sessions do not tell the agent to build', () => {
    useSkillsStore.getState().toggleSkill('fixture-tooling');
    const prompt = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(prompt).toContain('NEW FIREBASE TOOLING SESSION');
    expect(prompt).toContain('Do not treat that as a reason to build an app');
    expect(prompt).not.toContain('Go straight from your plan to building');
  });

  test('Claude lane gets matching Firebase tooling intent without browser-only tool names', () => {
    useSkillsStore.getState().toggleSkill('fixture-tooling');
    const prompt = buildClaudeLanePrompt({ diagnosticsEnabled: false });
    expect(prompt).toContain('FIREBASE TOOLING MODE');
    expect(prompt).toContain('mcp__playground__simulate_firestore_write');
    expect(prompt).toContain('Browser-only evidence');
    expect(prompt).not.toContain('seed_auth_users');
    expect(prompt).not.toContain('debug_firestore_rules');
    expect(prompt).not.toContain('BUILD App.tsx last');
  });
});
