import type { StrategyMode } from '~/lib/store/settings';
import type { ToolProfile } from '~/lib/tools';
import { routePrompt } from './strategy-router';
import type { AgentPromptProfile, SkillToolProfilePreference } from '~/lib/skills/registry';

export interface ToolProfileSettings {
  pyricDiagnosticsEnabled: boolean;
  strategyMode: StrategyMode;
}

export function selectToolProfileForPrompt({
  prompt,
  settings,
  delegated,
  promptProfile = 'app-builder',
  preference,
}: {
  prompt: string;
  settings: ToolProfileSettings;
  delegated: boolean;
  promptProfile?: AgentPromptProfile;
  preference?: SkillToolProfilePreference;
}): ToolProfile {
  if (delegated) return 'authoring';
  if (preference) return preference;
  if (promptProfile === 'firebase-tooling') return 'diagnostic';
  if (!settings.pyricDiagnosticsEnabled) return 'authoring';
  const routedStrategy =
    settings.strategyMode === 'auto'
      ? routePrompt(prompt, { promptProfile }).strategy
      : settings.strategyMode;
  if (routedStrategy === 'draft-validate') return 'diagnostic';
  if (promptNeedsDiagnosticTools(prompt)) return 'diagnostic';
  return 'authoring';
}

export function promptNeedsDiagnosticTools(prompt: string): boolean {
  return /\b(debug|diagnos|investigate|denied?|denials?|traffic|deployed rules?|live project|real project|firestore_get_rules|discover paths?|collection group|simulate|regression|permission|security rules?)\b/i.test(prompt);
}
