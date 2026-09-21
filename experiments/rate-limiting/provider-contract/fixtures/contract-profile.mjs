export const contractProfile = {
    schemaVersion: 1, revision: 'ai-logic-prelive-v1', liveValidated: false,
    scope: 'Prepared Firebase AI Logic GoogleAI v1beta generation adapter',
    releaseOn: ['fully consumed single-candidate response with STOP or MAX_TOKENS'],
    retainOn: ['local abort', 'deadline', 'closed stream without terminal marker', 'gateway crash', 'HTTP error', 'missing lookup', 'unsupported lookup'],
    retryInterruptedDispatch: false,
    automaticReconciliation: 'unavailable on the inspected generation interface',
    cancellationAcknowledgmentIsTerminal: false,
    consequence: 'Unknown operations can exhaust capacity indefinitely; no liveness guarantee without another documented terminal observation or an explicitly risk-bearing operator policy',
    terminalClassifier: 'terminal-evidence-v1',
    fixtureOracleUsableInProduction: false,
};
