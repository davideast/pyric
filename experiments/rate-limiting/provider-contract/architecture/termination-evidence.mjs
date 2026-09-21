export function terminalEvidence(observation) {
    // Oracle facts and local transport outcomes are never provider proof.
    if (!['provider-response', 'provider-status-query'].includes(observation.source)
        || observation.strength !== 'authoritative-terminal' || observation.scope !== 'one-provider-operation') return null;
    return ['completed', 'cancelled', 'rejected-before-start'].includes(observation.status) ? observation.status : null;
}
