import type { ToolProfile } from '~/lib/tools';
import type { AgentPromptProfile, SkillToolProfilePreference } from '~/lib/skills/registry';

export interface ToolProfileSettings {
  pyricDiagnosticsEnabled: boolean;
}

export function selectToolProfileForPrompt({
  prompt,
  settings,
  promptProfile = 'firebase',
  preference,
}: {
  prompt: string;
  settings: ToolProfileSettings;
  promptProfile?: AgentPromptProfile;
  preference?: SkillToolProfilePreference;
}): ToolProfile {
  if (preference) return preference;
  if (promptProfile === 'firebase') return 'diagnostic';
  if (!settings.pyricDiagnosticsEnabled) return 'authoring';
  if (promptNeedsDiagnosticTools(prompt)) return 'diagnostic';
  return 'authoring';
}

export function promptNeedsDiagnosticTools(prompt: string): boolean {
  return /\b(debug|diagnos|investigate|denied?|denials?|traffic|simulate|regression|permission|security rules?)\b/i.test(prompt);
}
