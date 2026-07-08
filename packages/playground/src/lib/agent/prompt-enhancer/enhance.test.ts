import { afterEach, describe, expect, test } from 'bun:test';
import { useSkillsStore } from '~/lib/store/skills';
import { resolveEnhancerActiveSkills } from './enhance';

describe('resolveEnhancerActiveSkills', () => {
  afterEach(() => {
    useSkillsStore.getState().clear();
  });

  test('uses explicit ids instead of stale global store state', () => {
    useSkillsStore.getState().hydrate(['game-rules']);

    expect(resolveEnhancerActiveSkills([]).map((skill) => skill.id)).toEqual([]);
  });

  test('falls back to store state for older callers', () => {
    useSkillsStore.getState().hydrate(['game-rules']);

    expect(resolveEnhancerActiveSkills().map((skill) => skill.id)).toEqual(['game-rules']);
  });
});
