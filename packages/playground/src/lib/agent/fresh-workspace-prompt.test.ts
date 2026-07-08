import { afterEach, describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from './system-prompt';
import { useWorkspaceStore } from '~/lib/store/workspace';

function resetWorkspace() {
  const ws = useWorkspaceStore.getState();
  ws.setRules('');
  ws.setAppSource('');
}

describe('buildSystemPrompt — fresh-workspace directive', () => {
  afterEach(resetWorkspace);

  test('empty Firebase workspace injects the Firebase directive', () => {
    resetWorkspace();
    const p = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(p).toContain('WORKSPACE STATE — NEW FIREBASE SESSION');
    expect(p).toContain('Do not treat that as a reason to build an app');
  });

  test('empty app-builder workspace injects the skip-discovery directive', () => {
    resetWorkspace();
    const p = buildSystemPrompt({
      diagnosticsEnabled: false,
      prompt: 'Build a todo app',
    });
    expect(p).toContain('WORKSPACE STATE — NEW SESSION');
    expect(p).toContain('skip the analyze phase');
    expect(p).toContain('Do NOT call `list_files`');
  });

  test('appSource present → directive omitted', () => {
    resetWorkspace();
    useWorkspaceStore.getState().setAppSource('export default function App(){return null}');
    const p = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(p).not.toContain('WORKSPACE STATE — NEW FIREBASE SESSION');
  });

  test('rules present alone → directive omitted', () => {
    resetWorkspace();
    useWorkspaceStore.getState().setRules("rules_version = '2';");
    const p = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(p).not.toContain('WORKSPACE STATE — NEW FIREBASE SESSION');
  });

  test('whitespace-only content still counts as fresh', () => {
    resetWorkspace();
    useWorkspaceStore.getState().setAppSource('   \n  ');
    const p = buildSystemPrompt({ diagnosticsEnabled: false });
    expect(p).toContain('WORKSPACE STATE — NEW FIREBASE SESSION');
  });
});
