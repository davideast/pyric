/**
 * Skill framework — the P1 invariants.
 *
 *  1. ZERO SKILLS ACTIVE ⇒ the system prompt is byte-identical to the
 *     pre-skills prompt (the feature is invisible until used).
 *  2. An active skill's brief lands as a fenced SKILL section (both
 *     lanes); inactive skills contribute nothing.
 *  3. The store round-trips through the session-payload shape and
 *     drops unknown ids.
 *  4. `man` exposes an active skill's page and hides inactive ones.
 *  5. Skill tools appear in the profile listing only while active.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ToolHandler } from '@inbrowser/agent';
import { buildSystemPrompt } from '~/lib/agent/system-prompt';
import { AGENT_SHELL_BUILTINS } from '~/lib/agent-shell/builtins';
import { listToolHandlersForProfile } from '~/lib/tools';
import { useSkillsStore } from '~/lib/store/skills';
import {
  __setSkillsForTest,
  listSkills,
  resolveActiveSkills,
  resolvePromptProfile,
  resolveWorkbenchIntent,
  skillById,
  type SkillDefinition,
} from './registry';

const FIXTURE_TOOL: ToolHandler = {
  name: 'fixture_skill_tool',
  description: 'fixture tool for skill-gating tests',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ ok: true }),
} as unknown as ToolHandler;

const FIXTURE_SKILL: SkillDefinition = {
  id: 'fixture-skill',
  label: 'Fixture skill',
  icon: 'science',
  description: 'test-only skill',
  brief: 'FIXTURE BRIEF LINE — consult `man fixture-topic` before acting.',
  manTopic: 'fixture-topic',
  manSummary: 'fixture-topic one-line summary',
  manBody: 'FIXTURE MAN BODY — the full pull-based knowledge.',
  tools: () => [FIXTURE_TOOL],
};

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
  toolProfilePreference: 'diagnostic',
};

const FILE_TOOLING_SKILL: SkillDefinition = {
  id: 'fixture-file-tooling',
  label: 'Fixture file tooling',
  icon: 'rule',
  description: 'test-only file-focused Firebase expert skill',
  brief: 'FIXTURE FILE TOOLING BRIEF',
  manTopic: 'fixture-file-tooling',
  manSummary: 'fixture file tooling one-line summary',
  manBody: 'fixture file tooling body',
  promptProfile: 'firebase',
  primarySurface: 'file',
  defaultFirebaseSubtab: 'traffic',
  defaultFilePath: '/workspace/firestore.rules',
};

const man = AGENT_SHELL_BUILTINS.find((c) => c.name === 'man')!;

beforeEach(() => {
  __setSkillsForTest([FIXTURE_SKILL, TOOLING_SKILL, FILE_TOOLING_SKILL]);
  useSkillsStore.getState().clear();
});

afterEach(() => {
  __setSkillsForTest(null);
  useSkillsStore.getState().clear();
});

describe('skill framework invariants', () => {
  test('zero skills active ⇒ byte-identical system prompt', () => {
    const withFramework = buildSystemPrompt({ diagnosticsEnabled: false });
    __setSkillsForTest([]); // registry empty = pre-skills world
    const preSkills = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(withFramework).toBe(preSkills);
  });

  test('active skill brief lands as a fenced SKILL section', () => {
    useSkillsStore.getState().toggleSkill('fixture-skill');
    const prompt = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(prompt).toContain('── SKILL: FIXTURE SKILL ──');
    expect(prompt).toContain('FIXTURE BRIEF LINE');
    // The full body never rides in the prompt — pull-based only.
    expect(prompt).not.toContain('FIXTURE MAN BODY');
  });

  test('store round-trips ids and drops unknown ones', () => {
    const s = useSkillsStore.getState();
    s.hydrate(['fixture-skill', 'removed-skill', 42 as never]);
    expect(useSkillsStore.getState().activeSkillIds).toEqual(['fixture-skill']);
    s.toggleSkill('fixture-skill');
    expect(useSkillsStore.getState().activeSkillIds).toEqual([]);
    s.toggleSkill('nonexistent'); // unknown id is a no-op
    expect(useSkillsStore.getState().activeSkillIds).toEqual([]);
  });

  test('man shows an active skill page and hides it when inactive', async () => {
    // Inactive: not listed, not readable.
    let index = await man.execute(['-k'], undefined as never);
    expect(index.stdout).not.toContain('fixture-topic');
    let page = await man.execute(['fixture-topic'], undefined as never);
    expect(page.exitCode).not.toBe(0);

    useSkillsStore.getState().toggleSkill('fixture-skill');
    index = await man.execute(['-k'], undefined as never);
    expect(index.stdout).toContain('fixture-topic');
    page = await man.execute(['fixture-topic'], undefined as never);
    expect(page.exitCode).toBe(0);
    expect(page.stdout).toContain('FIXTURE MAN BODY');
  });

  test('skill tools are listed only while the skill is active', () => {
    const namesOff = listToolHandlersForProfile('authoring').map((t) => t.name);
    expect(namesOff).not.toContain('fixture_skill_tool');
    useSkillsStore.getState().toggleSkill('fixture-skill');
    const namesOn = listToolHandlersForProfile('authoring').map((t) => t.name);
    expect(namesOn).toContain('fixture_skill_tool');
  });

  test('Firebase is the default prompt profile and tooling skills keep it', () => {
    expect(resolvePromptProfile(resolveActiveSkills([]))).toBe('firebase');
    useSkillsStore.getState().toggleSkill('fixture-tooling');
    const active = resolveActiveSkills(useSkillsStore.getState().activeSkillIds);
    expect(resolvePromptProfile(active)).toBe('firebase');
    expect(resolveWorkbenchIntent(active)).toMatchObject({
      promptProfile: 'firebase',
      primarySurface: 'firebase',
      defaultFirebaseSubtab: 'sandbox',
      toolProfilePreference: 'diagnostic',
    });
  });

  test('latest active tooling skill controls concrete workbench defaults', () => {
    const s = useSkillsStore.getState();
    s.toggleSkill('fixture-tooling');
    s.toggleSkill('fixture-file-tooling');
    const intent = resolveWorkbenchIntent(resolveActiveSkills(useSkillsStore.getState().activeSkillIds));
    expect(intent.primarySurface).toBe('file');
    expect(intent.defaultFirebaseSubtab).toBe('traffic');
    expect(intent.defaultFilePath).toBe('/workspace/firestore.rules');
  });

  test('shipped registry exposes the game and improvement toggles', () => {
    __setSkillsForTest(null);
    const ids = listSkills().map((skill) => skill.id);
    expect(ids).toEqual(['game-rules', 'improve-firebase']);
    expect(skillById('improve-firebase')).toMatchObject({
      label: 'Improve Firebase',
      promptProfile: 'firebase',
      primarySurface: 'firebase',
      toolProfilePreference: 'diagnostic',
    });

    // The broad firebase-tooling skills live in the always-on system
    // prompt (and as external-agent skills under .agents/skills), not
    // as chips. Their ids must stay unresolvable...
    const retired = [
      'firebase-audit',
      'firestore-rules-audit',
      'playground-firebase-auth-model',
      'playground-firestore-query-indexes',
      'rtdb-security-rules',
      'rtdb-data-model',
    ];
    for (const id of retired) expect(skillById(id)).toBeUndefined();

    // ...and sessions saved with them must still load (dropped, not
    // crashed).
    expect(resolveActiveSkills(['firebase-audit', 'improve-firebase']).map((s) => s.id)).toEqual([
      'improve-firebase',
    ]);
  });
});
