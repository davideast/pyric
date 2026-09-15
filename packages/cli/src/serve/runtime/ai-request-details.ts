import { aiModelHtml } from './ai-model-label.js';
import type { SdkServiceRate } from 'pyric/sandbox/internal';
import type { HistoryFrame } from './rate-history.js';

/** A bounded diagnostic list, separate from complete aggregate counters. */
export function aiRequestDetails(service: SdkServiceRate, escape: (value: string) => string, frame?: HistoryFrame, chevron = ''): string {
  const requests = (service.aiRequests ?? []).filter(request => !frame || ((request.startedSecond ?? request.second) <= frame.to && (request.status === 'pending' || request.second >= frame.from)));
  const rows = [...requests].reverse().map(request => {
    const ai = request.detail;
    const localCount = request.method === 'countTokens' && (ai.usageSource === 'estimated' || ai.usageSource === 'scripted');
    const model = localCount ? 'Token estimate' : ai.reportedModel ?? ai.routedModel ?? (ai.engine === 'scripted' ? 'Scripted response' : 'Model unknown');
    const fact = (label: string, value: string) => `<dt>${label}</dt><dd>${escape(value)}</dd>`;
    const tokens = (value?: number) => value === undefined ? 'Unknown' : value.toLocaleString();
    return `<details class="rules-disclosure" data-ai-request="${escape(request.id)}"><summary><span>${localCount ? escape(model) : aiModelHtml(ai, escape)}</span><span class="ai-request-meta"><span>${request.status === 'pending' ? 'In progress' : request.status === 'failed' ? 'Failed' : 'Completed'}</span><span class="rules-chevron">${chevron}</span></span></summary><div class="usage-notes-body"><dl class="usage-coverage">`
      + fact('Requested as', ai.requestedModel)
      + fact(localCount ? 'Configured route' : 'Routed to', ai.routedModel ?? (ai.engine === 'scripted' ? 'No model invoked' : 'Unknown'))
      + (localCount ? fact('Execution', 'Local estimate; no model invoked') : '')
      + fact('Reported by backend', ai.reportedModel ?? 'Not reported')
      + fact('Backend', ({ openai: 'OpenAI-compatible', gemini: 'Gemini', scripted: 'Scripted', custom: 'Custom', unknown: 'Unknown' }[ai.engine]) + (ai.endpoint ? ` · ${ai.endpoint}` : ''))
      + (ai.mappingReason ? fact('Mapping', ai.mappingReason) : '')
      + fact('Operation', request.method)
      + fact('Time', new Date(request.at).toLocaleTimeString())
      + fact('Duration', ai.durationMs === undefined ? 'Unknown' : `${Math.round(ai.durationMs)} ms`)
      + (ai.firstChunkMs === undefined ? '' : fact('First chunk', `${Math.round(ai.firstChunkMs)} ms`))
      + fact('Token source', { backend: 'Backend reported', estimated: 'Local estimate', scripted: 'Scripted / synthetic', unknown: 'Unknown' }[ai.usageSource])
      + (request.method === 'countTokens' ? fact('Counted tokens', tokens(ai.totalTokens)) : fact('Input tokens', tokens(ai.inputTokens)) + fact('Output tokens', tokens(ai.outputTokens)))
      + '</dl></div></details>';
  }).join('');
  return `<details class="rules-disclosure usage-notes" data-ai-requests><summary><span>Model requests</span><span class="ai-request-meta"><span>${requests.length}</span><span class="rules-chevron">${chevron}</span></span></summary><p class="usage-gap">Up to 100 recent requests; aggregate counts are recorded independently. Times measure this client. Routing is configuration; reported identity is the backend’s claim.</p><div class="rows">${rows || '<p class="usage-gap">No retained requests in this period.</p>'}</div></details>`;
}
