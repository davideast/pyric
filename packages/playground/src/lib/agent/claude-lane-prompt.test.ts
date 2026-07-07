/**
 * Lane-prompt composition pins (user-found, trace t-mq9msa9m-xcgt):
 * the Claude lane's system prompt must describe the MCP bridge's REAL
 * tool surface — never the browser registry's names — while keeping
 * the #575/W2.2-pinned guidance verbatim from the ONE source of truth
 * (`./system-prompt.ts`). A drifted prompt here is exactly the
 * text-as-tool-call failure this lane shipped with.
 */
import { describe, expect, test } from 'bun:test';
import { buildClaudeLanePrompt } from './claude-lane-prompt';
import { buildSystemPrompt } from './system-prompt';
import { MCP_TOOL_NAMES } from '~/lib/server/claude-mcp';

const laneOn = buildClaudeLanePrompt({ diagnosticsEnabled: true });
const laneOff = buildClaudeLanePrompt({ diagnosticsEnabled: false });

describe('claude lane prompt — MCP tool surface', () => {
  test('names every bridge tool by its real mcp__playground__ name (no drift)', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(laneOff).toContain(`mcp__playground__${name}`);
    }
  });

  test('the canonical stdlib mandate (bare tool names) is replaced, not repeated', () => {
    // The exact phrasing the Opus turn obeyed as TEXT.
    expect(laneOff).not.toContain('Call `firestore_rules_stdlib_list` ONCE early');
    expect(laneOn).not.toContain('Call `firestore_rules_stdlib_list` ONCE early');
    // The mandate survives, restated against the real name.
    expect(laneOff).toContain('`mcp__playground__firestore_rules_stdlib_list` ONCE');
  });

  test('browser-registry tool names that are NOT on the bridge are absent', () => {
    for (const absent of [
      'sandbox_discover_paths',
      'firestore_extract_indexes',
      'seed_auth_users',
      'inspect_auth_users',
      'inspect_denial',
      'debug_firestore_rules',
      'try_rules_edit',
      'firestore_discover_paths',
      'DIAGNOSTIC PLAYBOOK',
      'DOCS ON DEMAND',
    ]) {
      expect(laneOn).not.toContain(absent);
      expect(laneOff).not.toContain(absent);
    }
  });

  test('tells the session its Claude Code built-ins are off', () => {
    expect(laneOff).toContain('NOT available in this session');
  });
});

describe('claude lane prompt — protected pins stay verbatim', () => {
  test('auth-UI guidance (the #575 pins)', () => {
    for (const p of [laneOn, laneOff]) {
      expect(p).toContain('NEVER render a developer identity-switcher');
      expect(p).toContain('no uid dropdowns');
      expect(p).toContain('SANDBOX/TOOL contexts only');
      expect(p).toContain('NEVER in App.tsx');
    }
  });

  test('anti-footgun invariants (W2.2 pins)', () => {
    for (const p of [laneOn, laneOff]) {
      expect(p).toContain('replaces the whole file');
      expect(p).toContain('@pyric/*');
      expect(p).toContain('signInWithCustomToken');
      expect(p).toContain('UI STYLE');
      expect(p).toContain('WORKSPACE FILES:');
      expect(p).toContain('/workspace/src/App.tsx');
      expect(p).toContain('/workspace/firestore.rules');
      expect(p).not.toContain('── CURRENT RULES ──');
      expect(p).not.toContain('── CURRENT APP ──');
    }
  });

  test('rules pitfalls ride along when diagnostics are on', () => {
    expect(laneOn).toContain('RULES PITFALLS');
    expect(laneOn).toContain('request.resource.data');
    expect(laneOff).not.toContain('RULES PITFALLS');
  });

  test('shared sections are literally shared with the canonical prompt (one source)', () => {
    const canonical = buildSystemPrompt({ diagnosticsEnabled: false });
    // Spot-check a long pinned paragraph: byte-identical in both prompts.
    const authUiLine = canonical
      .split('\n')
      .find((l) => l.includes('NEVER render a developer identity-switcher'));
    expect(authUiLine).toBeDefined();
    expect(laneOff).toContain(authUiLine!);
  });
});
