import type { AgentPromptProfile } from '~/lib/skills/registry';
import type { Tab } from './PanelTabs';

export type WorkspaceTabId = 'preview' | 'firebase' | 'file';

export type FirebaseWorkbenchSubTab =
  | 'ideas'
  | 'data'
  | 'auth'
  | 'sandbox'
  | 'traffic'
  | 'seed'
  | 'suggestions'
  | 'deploy';

export function workspaceTabsForProfile(
  promptProfile: AgentPromptProfile = 'firebase',
): readonly Tab[] {
  const tabs: readonly Tab[] = [
    { id: 'preview', label: 'Preview' },
    { id: 'firebase', label: 'Firebase' },
    { id: 'file', label: 'File' },
  ];
  if (promptProfile === 'firebase') {
    return [tabs[1]!, tabs[2]!, tabs[0]!];
  }
  return tabs;
}

export function firebaseSubTabsForProfile(
  promptProfile: AgentPromptProfile = 'firebase',
): readonly Tab[] {
  const focused: readonly Tab[] = [
    { id: 'sandbox', label: 'Sandbox' },
    { id: 'data', label: 'Data' },
    { id: 'auth', label: 'Auth' },
    { id: 'traffic', label: 'Traffic' },
    { id: 'seed', label: 'Seed' },
  ];
  if (promptProfile === 'firebase') return focused;
  return [
    ...focused,
    { id: 'ideas', label: 'Ideas' },
    { id: 'suggestions', label: 'Suggestions' },
    { id: 'deploy', label: 'Deploy' },
  ];
}
