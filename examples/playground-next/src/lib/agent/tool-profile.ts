import type { StrategyMode } from '~/lib/store/settings';
import type { ToolProfile } from '~/lib/tools';
import { routePrompt } from './strategy-router';

export interface ToolProfileSettings {
  pyricDiagnosticsEnabled: boolean;
  strategyMode: StrategyMode;
}

export function selectToolProfileForPrompt({
  prompt,
  settings,
  delegated,
}: {
  prompt: string;
  settings: ToolProfileSettings;
  delegated: boolean;
}): ToolProfile {
  if (delegated) return 'authoring';
  if (!settings.pyricDiagnosticsEnabled) return 'authoring';
  const routedStrategy =
    settings.strategyMode === 'auto' ? routePrompt(prompt).strategy : settings.strategyMode;
  if (routedStrategy === 'draft-validate') return 'diagnostic';
  if (promptNeedsDiagnosticTools(prompt)) return 'diagnostic';
  return 'authoring';
}

export function promptNeedsDiagnosticTools(prompt: string): boolean {
  return /\b(debug|diagnos|investigate|denied?|denials?|traffic|deployed rules?|live project|real project|firestore_get_rules|discover paths?|collection group|simulate|regression|permission|security rules?)\b/i.test(prompt);
}
