import type { SdkActivityRecord } from 'pyric/sandbox/internal';
type Identity = NonNullable<SdkActivityRecord['ai']>;
export function aiModelRoute(ai: Identity, method?: string): string {
  if (method === 'countTokens' && ai.usageSource === 'estimated') return 'Local estimate — no model invoked';
  return ai.engine === 'scripted' ? 'Scripted — no model invoked' : ai.routedModel ?? 'Unknown';
}
export function aiModelLabel(ai: Identity, method?: string): string {
  return `Requested ${ai.requestedModel.replace(/^models\//, '')} → Routed ${aiModelRoute(ai, method)}`;
}
export function aiModelHtml(ai: Identity, escape: (text: string) => string, method?: string): string {
  return `<span class="ai-model-pair"><span>Requested</span><span>${escape(ai.requestedModel.replace(/^models\//, ''))}</span><span>Routed to</span><span>${escape(aiModelRoute(ai, method))}</span></span>`;
}
