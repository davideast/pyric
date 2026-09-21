// Prepared non-streaming transport; not exercised by local runs.
// Wire format follows the installed Firebase AI Logic SDK. No automatic retries.
export function aiLogic({ projectId, model, apiKey, appId, credentials, reserveDispatch, record, timeoutMs = 30000, maxOutputTokens = 32, fetchImpl = (url, options) => fetch(url, options) }) {
    if (!/^[a-zA-Z0-9-]+$/.test(projectId) || !/^[a-zA-Z0-9.-]+$/.test(model) || !apiKey || !appId || typeof reserveDispatch !== 'function')
        throw new Error('Explicit AI Logic target and shared dispatch-budget callback required');
    return { async generate(request) {
            const { idToken, appCheckToken } = await credentials(request.uid);
            if (!idToken || !appCheckToken)
                throw new Error('Firebase Auth and App Check credentials required');
            // Budget must be enforced by the deployed service across all its instances.
            if (!await reserveDispatch(request))
                throw new Error('inference_budget_exhausted');
            record('inference-dispatch', { uid: request.uid, requestId: request.requestId, category: request.category, model, provider: 'firebase-ai-logic' });
            const response = await fetchImpl(`https://firebasevertexai.googleapis.com/v1beta/projects/${projectId}/models/${model}:generateContent`, {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'X-Firebase-Appid': appId, 'X-Firebase-AppCheck': appCheckToken, Authorization: `Firebase ${idToken}` },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: request.prompt }] }], generationConfig: { maxOutputTokens } }),
            });
            record('inference-response', { uid: request.uid, requestId: request.requestId, httpStatus: response.status });
            if (!response.ok)
                throw new Error(`ai_logic_http_${response.status}`);
            const body = await response.json();
            record('inference-complete', { uid: request.uid, requestId: request.requestId, usage: body.usageMetadata ?? null });
            return { text: body.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '' };
        } };
}
