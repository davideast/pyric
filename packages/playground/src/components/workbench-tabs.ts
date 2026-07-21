import type { AgentPromptProfile } from '~/lib/skills/registry';
import type { Tab } from './PanelTabs';

export type WorkspaceTabId = 'preview' | 'firebase' | 'file';

export type FirebaseWorkbenchSubTab =
  | 'ideas'
  | 'data'
  | 'rtdb'
  | 'auth'
  | 'sandbox'
  | 'traffic'
  | 'seed'
  | 'suggestions';

export function workspaceTabsForProfile(
  promptProfile: AgentPromptProfile = 'firebase',
  previewEnabled = true,
): readonly Tab[] {
  const tabs: readonly Tab[] = [
    { id: 'preview', label: 'Preview' },
    { id: 'firebase', label: 'Firebase' },
    { id: 'file', label: 'File' },
  ];
  const visible = previewEnabled ? tabs : tabs.filter((tab) => tab.id !== 'preview');
  if (promptProfile === 'firebase') {
    return [tabs[1]!, tabs[2]!, ...(previewEnabled ? [tabs[0]!] : [])];
  }
  return visible;
}

export function firebaseSubTabsForProfile(
  promptProfile: AgentPromptProfile = 'firebase',
): readonly Tab[] {
  const focused: readonly Tab[] = [
    { id: 'sandbox', label: 'Sandbox' },
    { id: 'data', label: 'Data' },
    { id: 'rtdb', label: 'RTDB' },
    { id: 'auth', label: 'Auth' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'seed', label: 'Seed' },
  ];
  if (promptProfile === 'firebase') return focused;
  return [
    ...focused,
    { id: 'ideas', label: 'Ideas' },
    { id: 'suggestions', label: 'Suggestions' },
  ];
}
