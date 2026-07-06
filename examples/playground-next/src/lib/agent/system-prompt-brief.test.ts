/**
 * W2.2 — pins for the collapsed environment brief. The system prompt is
 * now an SSH-MOTD-style brief; mid-task detail lives in the pull-based
 * `man` pages. These tests pin BOTH halves of that contract:
 *   1. the brief tells the model where the docs are (otherwise the
 *      pull-based system is unreachable knowledge), and
 *   2. the standing prompt stays collapsed — a budget pin so orchestration
 *      prose doesn't silently creep back (the gate is prefix < 9530 tok;
 *      the prompt's share of that budget is asserted here).
 */
import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from './system-prompt';
import { listSkills } from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';

describe('W2.2 environment brief', () => {
  const diagOn = buildSystemPrompt({ diagnosticsEnabled: true });
  const diagOff = buildSystemPrompt({ diagnosticsEnabled: false });

  test('points at the man pages (docs on demand)', () => {
    for (const p of [diagOn, diagOff]) {
      expect(p).toContain('man -k');
      expect(p).toContain('man workflow');
      expect(p).toContain('man rules');
    }
    // The diagnostic playbook additionally routes to its own page.
    expect(diagOn).toContain('man diagnostics');
  });

  test('keeps the anti-footgun invariants in the standing prompt', () => {
    for (const p of [diagOn, diagOff]) {
      // write_file semantics — the invariant that prevents damage.
      expect(p).toContain('replaces the whole file');
      expect(p).toContain('edit_file');
      // Deploy-bundle + preview deny-lists (PyricLeakError class of bug).
      expect(p).toContain('@pyric/*');
      expect(p).toContain('signInWithCustomToken');
    }
    // Diag-gated pyric wisdom: pitfalls stay terse but present.
    expect(diagOn).toContain('RULES PITFALLS');
    expect(diagOn).toContain('request.resource.data');
    // #514 — simulate must not re-ship the ruleset every call.
    expect(diagOn).toContain('OMIT `rules`');
  });

  test('uses stable workspace file references instead of full file fences', () => {
    for (const p of [diagOn, diagOff]) {
      expect(p).toContain('WORKSPACE FILES:');
      expect(p).toContain('/workspace/src/App.tsx');
      expect(p).toContain('/workspace/firestore.rules');
      expect(p).not.toContain('── CURRENT RULES ──');
      expect(p).not.toContain('── CURRENT APP ──');
    }
  });

  test('stays collapsed — token budget pin (chars/4, empty workspace)', () => {
    // Pre-W2.2 the diag-on prompt was ≈4324 tok. The collapse landed at
    // ≈2363; this asserts a ceiling with headroom for small additions,
    // failing loudly if walkthrough prose creeps back in. Ceilings raised
    // deliberately, not creep: (a) the prompt had ALREADY crept past the
    // old ceiling before any of this (diag-on ≈2847 on the base branch);
    // (b) WORKFLOW_PHASES (feature #11, ≈190 tok); (c) the fresh-workspace
    // directive (≈60 tok, present in THIS empty-workspace measurement) —
    // which pays for itself by deleting a whole ~16k-token discovery turn
    // on every new session.
    expect(Math.round(diagOn.length / 4)).toBeLessThan(3200);
    expect(Math.round(diagOff.length / 4)).toBeLessThan(2600);
  });

  test('skill briefs stay pointer-sized — ALL skills active budget pin', () => {
    // Skills are opt-in, so their briefs sit OUTSIDE the base ceiling —
    // but each brief must stay a POINTER (~10 lines; the body is the
    // pull-based man page — the killed C3 push-injection lesson). Two
    // pins: per-skill brief ≤ 260 tok, and the whole prompt with EVERY
    // registered skill active ≤ base + 300/skill.
    const skills = listSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(Math.round(s.brief.length / 4)).toBeLessThan(260);
    }
    for (const s of skills) useSkillsStore.getState().toggleSkill(s.id);
    const allOn = buildSystemPrompt({ diagnosticsEnabled: true });
    expect(Math.round(allOn.length / 4)).toBeLessThan(3200 + skills.length * 300);
    useSkillsStore.getState().clear();
  });
});
