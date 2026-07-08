import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from './system-prompt';
import { __setSkillsForTest, type SkillDefinition } from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';
import { useWorkspaceStore } from '~/lib/store/workspace';

const TOOLING_SKILL: SkillDefinition = {
  id: 'fixture-tooling',
  label: 'Fixture tooling',
  icon: 'policy',
  description: 'test-only Firebase expert skill',
  brief: 'FIXTURE TOOLING BRIEF',
  manTopic: 'fixture-tooling',
  manSummary: 'fixture tooling one-line summary',
  manBody: 'fixture tooling body',
  promptProfile: 'firebase',
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
  test('default Firebase expert prompt replaces app-building guidance', () => {
    const prompt = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(prompt).toContain('FIREBASE EXPERT MODE');
    expect(prompt).toContain('Pyric is the local Firebase runtime');
    expect(prompt).toContain('Do NOT create or edit `/workspace/src/App.tsx`');
    expect(prompt).toContain('rules, workspace tests, seed data, Auth users');
    expect(prompt).not.toContain('BUILD App.tsx last');
    expect(prompt).not.toContain('UI STYLE');
    expect(prompt).not.toContain('NO IN-APP BACKEND/SEED/ADMIN CODE');
  });

  test('Firebase expert prompt teaches live seed data and Firestore ID policy', () => {
    const prompt = buildSystemPrompt({
      diagnosticsEnabled: false,
      prompt: 'Model Firestore data for teams with role based access',
    });
    expect(prompt).toContain('FIRESTORE SEED ID POLICY');
    expect(prompt).toContain('call `seed_firestore_data_as_admin`');
    expect(prompt).toContain('test-file `seed` blocks');
    expect(prompt).toContain('Use `autoId: true` for addDoc-style user-created docs');
    expect(prompt).toContain('Use explicit IDs for semantic or stable docs');
    expect(prompt).toContain('membership docs keyed by UID');
    expect(prompt).toContain('read `data.generated`');
    expect(prompt).toContain('RULES-FIRST FIRESTORE DATA MODELING WORKSHOP');
    expect(prompt).toContain('using the Firestore seed ID policy');
  });

  test('app-building prompt keeps the app workflow', () => {
    const prompt = buildSystemPrompt({
      diagnosticsEnabled: false,
      prompt: 'Build a notes app with Firestore rules',
    });
    expect(prompt).toContain('BUILD App.tsx last');
    expect(prompt).toContain('UI STYLE');
    expect(prompt).toContain('NO IN-APP BACKEND/SEED/ADMIN CODE');
    expect(prompt).toContain('FIRESTORE SEED ID POLICY');
    expect(prompt).toContain('SEED with `seed_firestore_data_as_admin` using the Firestore seed ID policy');
    expect(prompt).not.toContain('SEED with `seed_firestore_data_as_admin` (`autoId: true`)');
  });

  test('Firebase expert prompt can still include active specialist briefs', () => {
    useSkillsStore.getState().toggleSkill('fixture-tooling');
    const prompt = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(prompt).toContain('FIREBASE EXPERT MODE');
    expect(prompt).toContain('FIXTURE TOOLING BRIEF');
    expect(prompt).toContain('Do NOT create or edit `/workspace/src/App.tsx`');
    expect(prompt).toContain('rules, workspace tests, seed data, Auth users');
    expect(prompt).not.toContain('BUILD App.tsx last');
    expect(prompt).not.toContain('UI STYLE');
    expect(prompt).not.toContain('NO IN-APP BACKEND/SEED/ADMIN CODE');
  });

  test('fresh Firebase expert sessions do not tell the agent to build', () => {
    const prompt = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(prompt).toContain('NEW FIREBASE SESSION');
    expect(prompt).toContain('Do not treat that as a reason to build an app');
    expect(prompt).not.toContain('Go straight from your plan to building');
  });

});
