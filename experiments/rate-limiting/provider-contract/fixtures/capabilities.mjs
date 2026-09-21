export const fixtureVersion = 'provider-contract-fixtures-v1';
export const providerCapabilities = {
    schemaVersion: 1, provider: 'Firebase AI Logic / GoogleAI backend', api: 'v1beta generateContent + streamGenerateContent',
    inspectedSdk: '@firebase/ai@2.12.0', firebaseSdk: '12.13.0', retrievedAt: '2026-09-20', liveTested: false,
    sdkEntrypointSha256: 'aff092f4c61f4101d9f3766ade72bd568b0e74b7a40dddacc4af192a33d2ae1f',
    model: null, transport: 'prepared direct HTTP shaped after the pinned SDK; not an SDK behavioral-parity claim',
    references: {
        generation: 'https://firebase.google.com/docs/ai-logic/generate-text',
        streaming: 'https://firebase.google.com/docs/ai-logic/stream-responses',
        surface: 'https://firebase.google.com/docs/reference/js/ai.generativemodel',
        abort: 'https://firebase.google.com/docs/reference/js/ai.singlerequestoptions.md',
        response: 'https://firebase.google.com/docs/reference/js/ai.generatecontentresponse',
        production: 'https://firebase.google.com/docs/ai-logic/production-checklist',
    },
    capabilities: {
        nonStreaming: { status: 'supported', reference: 'generation', scope: 'documented generation response; live untested' },
        streaming: { status: 'supported', reference: 'streaming', scope: 'documented output stream; live untested' },
        clientAbort: { status: 'supported', reference: 'abort', scope: 'SDK AbortSignal wired to fetch; remote termination unverified' },
        remoteCancellation: { status: 'unsupported', reference: 'surface', scope: 'no explicit operation cancellation exposed by the inspected generation surface; backend behavior on abort remains unverified' },
        durableOperationLookup: { status: 'unsupported', reference: 'surface', scope: 'no durable generation operation lookup exposed by this SDK/API surface' },
        callerKeyLookup: { status: 'unsupported', reference: 'surface', scope: 'no caller-key lookup on inspected generation surface' },
        deduplicatedDispatch: { status: 'unverified', reference: 'surface', scope: 'no documented generation idempotency guarantee found; do not retry interrupted calls' },
        perOperationUsage: { status: 'supported', reference: 'response', scope: 'usage metadata on a received response when supplied; interrupted usage can remain unknown' },
    },
    inspection: ['makeRequest performs one fetch and combines AbortSignal inputs.', 'SDK streaming timeout clears after headers; the prepared direct adapter bounds the whole response instead.', 'No response ID is treated as a queryable operation ID. Missing APIs mean unsupported in this adapter, not proof of provider-internal impossibility.'],
};
export const fixtureProfiles = {
    observable: { explicitStop: 'acknowledged; confirmation independently controlled', lookup: 'supported', deduplication: 'supported fixture contract' },
    unobservable: { explicitStop: 'unsupported', lookup: 'unsupported', deduplication: 'unsupported' },
    missing: { explicitStop: 'supported', lookup: 'missing; unknown', deduplication: 'supported fixture contract' },
    inaccessible: { explicitStop: 'supported', lookup: 'inaccessible; unknown', deduplication: 'supported fixture contract' },
};
