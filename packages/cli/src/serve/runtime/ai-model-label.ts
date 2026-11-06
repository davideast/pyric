import type { SdkActivityRecord } from 'pyric/sandbox/internal';
type Identity = NonNullable<SdkActivityRecord['ai']>;
/** Who answered the call: the sandbox's configured route, or production's own model. */
export type AiServedBy = 'sandbox' | 'production';
export function aiModelRoute(ai: Identity, method?: string, servedBy: AiServedBy = 'sandbox'): string {
  // Production routes the call itself; the only model it names is the one it reports.
  if (servedBy === 'production') return ai.reportedModel ?? 'Not reported';
  if (method === 'countTokens' && ai.usageSource === 'estimated') return 'Local estimate — no model invoked';
  return ai.engine === 'scripted' ? 'Scripted — no model invoked' : ai.routedModel ?? 'Unknown';
}
export function aiModelLabel(ai: Identity, method?: string): string {
  return `Requested ${ai.requestedModel.replace(/^models\//, '')} → Routed ${aiModelRoute(ai, method)}`;
}
export function aiModelHtml(ai: Identity, escape: (text: string) => string, method?: string, servedBy: AiServedBy = 'sandbox'): string {
  return `<span class="ai-model-pair"><span>Requested</span><span>${escape(ai.requestedModel.replace(/^models\//, ''))}</span><span>Routed to</span><span>${escape(aiModelRoute(ai, method, servedBy))}</span></span>`;
}
