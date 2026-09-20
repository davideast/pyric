export function fakeInference(record, { delayMs = 0, fail = false } = {}) {
    return { async generate(request) {
            record('inference-dispatch', { requestId: request.requestId, uid: request.uid, category: request.category });
            if (delayMs)
                await new Promise(resolve => setTimeout(resolve, delayMs));
            if (fail)
                throw new Error('fake_provider_failure');
            record('inference-complete', { requestId: request.requestId, uid: request.uid });
            return { text: 'fixture response' };
        } };
}
