// Prepared GoogleAI backend HTTP path, inspected against @firebase/ai 2.12.0.
// Direct fetch has no SDK retries. This does not implement a remote stop/status API.
export function aiLogicContract({ projectId, model, appId, apiKey, credentials, reserveDispatch, emit,
    maxOutputTokens = 64, timeoutMs = 30000, loopbackFixture, allowRealInference = false }) {
    if (!/^[a-zA-Z0-9-]+$/.test(projectId) || !/^[a-zA-Z0-9.-]+$/.test(model)
        || !appId || !apiKey || typeof credentials !== 'function' || typeof reserveDispatch !== 'function'
        || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 64
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Explicit bounded AI Logic target required');
    if (loopbackFixture && !/^http:\/\/127\.0\.0\.1:\d+$/.test(loopbackFixture)) throw new Error('Fixture must be loopback');
    if (!loopbackFixture && !allowRealInference) throw new Error('Real inference is not enabled');
    const base = loopbackFixture ?? 'https://firebasevertexai.googleapis.com';
    const observe = async value => { const result = { providerOperationIdOrigin: 'unavailable', evidenceClass: value.source, providerOperationId: null, observedAt: new Date().toISOString(), scope: 'one-provider-operation', usage: null, ...value }; await emit(result); return result; };
    const unsupported = () => observe({ status: 'unsupported', source: 'gateway-observation', strength: 'none', reason: 'not-exposed-by-pinned-generation-api' });
    return { requestStop: unsupported, observe: unsupported,
        async start({ prompt, streaming = false, signal }) {
            const controller = new AbortController();
            if (signal?.aborted) return { providerOperationId: null, completion: observe({ status: 'rejected-before-start', source: 'gateway-observation', strength: 'none' }) };
            const tokens = await credentials();
            if (!tokens?.idToken || !tokens?.appCheckToken) throw new Error('Auth and App Check credentials required');
            if (signal?.aborted) return { providerOperationId: null, completion: observe({ status: 'rejected-before-start', source: 'gateway-observation', strength: 'none' }) };
            if (!await reserveDispatch()) throw new Error('dispatch-budget-exhausted');
            const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const completion = (async () => {
                try {
                    await observe({ status: 'dispatch', source: 'gateway-observation', strength: 'none' });
                    const response = await fetch(`${base}/v1beta/projects/${projectId}/models/${model}:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
                        method: 'POST', redirect: 'error', signal: combined,
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'X-Firebase-Appid': appId,
                            'X-Firebase-AppCheck': tokens.appCheckToken, Authorization: `Firebase ${tokens.idToken}` },
                        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens, candidateCount: 1 } }),
                    });
                    await observe({ status: 'headers', source: 'provider-response', strength: 'informational', httpStatus: response.status });
                    if (!response.ok) { await response.body?.cancel(); throw new Error('http-outcome-unknown'); }
                    let usage = null, finished = false, bytes = 0, pending = '';
                    const consume = async body => {
                        // Never retain prompt/generated text or opaque response bodies.
                        if (body.usageMetadata) usage = Object.fromEntries(['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount'].filter(k => Number.isFinite(body.usageMetadata[k]) && body.usageMetadata[k] >= 0).map(k => [k, body.usageMetadata[k]]));
                        if (Array.isArray(body.candidates) && body.candidates.length === 1 && ['STOP', 'MAX_TOKENS'].includes(body.candidates[0]?.finishReason)) finished = true;
                        await observe({ status: 'chunk', source: 'provider-response', strength: 'informational', usage, finalMarker: finished });
                    };
                    const decoder = new TextDecoder('utf-8', { fatal: true });
                    for await (const chunk of response.body) {
                        bytes += chunk.length; if (bytes > 1048576) throw new Error('response-budget-exhausted');
                        pending = (pending + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
                        if (streaming) {
                            let end;
                            while ((end = pending.indexOf('\n\n')) >= 0) {
                                const block = pending.slice(0, end); pending = pending.slice(end + 2);
                                const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                                if (data && data !== '[DONE]') await consume(JSON.parse(data));
                            }
                        }
                    }
                    pending += decoder.decode();
                    if (!streaming) await consume(JSON.parse(pending));
                    else if (pending.trim()) throw new Error('truncated-stream');
                    await observe({ status: finished ? 'completed' : 'unknown', source: 'provider-response',
                        strength: finished ? 'authoritative-terminal' : 'none', usage, bytes,
                        reason: finished ? 'complete-response-with-generation-finish-reason' : 'no-generation-finish-reason' });
                } catch {
                    await observe({ status: 'unknown', source: 'gateway-observation', strength: 'none', reason: 'transport-or-response-failure' });
                } finally { controller.abort(); clearTimeout(timer); }
            })();
            return { providerOperationId: null, completion, abortTransport: () => controller.abort() };
        },
    };
}
