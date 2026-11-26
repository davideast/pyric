// An evaluation failure can refuse a legal write. An illegal write refused
// by the same failure does not establish that the intended guard worked.
export function classify(result, expected) {
  const refused = result.decision === 'DENY';
  const accepted = result.decision === 'ALLOW';
  if (result.unsupported) return {status:'unsupported',cause:'unsupported',kind:'unsupported'};
  const cause = result.resourceLimit ? 'resource-limit'
    : refused && result.trace?.some(t => t.verdict === 'ERROR') ? 'rule-error' : null;
  if (cause) {
    const status = refused && expected ? 'false-refusal' : 'evaluation-error';
    return {status,cause,kind:status+'/'+cause};
  }
  if (!accepted && !refused) return {status:'evaluation-error',cause:'invalid-decision',kind:'evaluation-error/invalid-decision'};
  const status = accepted === expected ? 'match' : accepted ? 'false-allow' : 'false-refusal';
  return {status,cause:null,kind:status};
}
