export const diagnosticEvents = [
 'page-ready','page-hidden','page-shown','worker-connected','ai-port-received',
 'ai-port-reused','ai-port-attached','ai-probe-ok','ai-probe-failed',
 'model-wait','model-connected','model-stream-open','model-first-chunk',
 'model-complete','model-failed','stage','checkpoint-start','checkpoint-end',
 'checkpoint-failed','app-load-start','app-load-end','app-load-failed',
 'draft-load-start','draft-load-end','draft-load-failed','draft-save-start',
 'draft-save-end','draft-save-failed',
] as const;
export type DiagnosticEvent = typeof diagnosticEvents[number];
const stages = ['plan','policy-source','policy-cases','policy-check','ui','code','compile','startup','save','done'];
export function safeDiagnostic(value: unknown) {
 if (!value || typeof value !== 'object') return null;
 const v=value as Record<string,unknown>;
 if(!diagnosticEvents.includes(v.event as DiagnosticEvent) || typeof v.trace!=='string' || !/^[0-9a-f-]{36}$/.test(v.trace))return null;
 const result: Record<string,string|number>={event:v.event as string,trace:v.trace};
 if(typeof v.stage==='string'&&stages.includes(v.stage))result.stage=v.stage;
 if(typeof v.elapsedMs==='number'&&Number.isFinite(v.elapsedMs)&&v.elapsedMs>=0)result.elapsedMs=Math.min(Math.round(v.elapsedMs),3600000);
 if(typeof v.code==='string'&&['timeout','aborted','error'].includes(v.code))result.code=v.code;
 return result;
}
