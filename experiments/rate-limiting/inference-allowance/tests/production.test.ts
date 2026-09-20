import { expect, test } from 'bun:test';
import { preflight } from '../adapters/preflight.mjs';
test('production preflight refuses unsafe targets and does not imply inference coverage', async () => {
    const config = { profile: 'production-integration', projectId: 'test-project', databaseId: 'quota-tests', gatewayUrl: 'http://example.com', inference: { api: 'generateContent', model: 'test-model' }, limits: { maxRequests: 50, maxInferenceDispatches: 5, maxDurationSeconds: 120 } };
    expect((await preflight(config)).ready).toBe(false);
    const secure = { ...config, gatewayUrl: 'https://gateway.example.com' };
    const result = await preflight(secure);
    expect(result.ready).toBe(false);
    expect(result.checks.some(c => c.name === 'deployed enforcement coverage' && c.status === 'unverified')).toBe(true);
    const stream = await preflight({ ...secure, inference: { ...secure.inference, api: 'generateContentStream' }, enforcement: 'ai-logic-hook' });
    expect(stream.checks.some(c => c.status === 'failed' && c.name === 'inference route')).toBe(true);
});
import { aiLogic } from '../services/ai-logic.mjs';
test('AI Logic transport enforces its dispatch budget and omits credentials from evidence', async () => {
    const events = [];
    let sends = 0, credits = 1;
    const service = aiLogic({ projectId: 'test-project', model: 'test-model', apiKey: 'secret-api-key', appId: 'test-app',
        credentials: async () => ({ idToken: 'secret-user-token', appCheckToken: 'secret-app-check' }),
        reserveDispatch: async () => credits-- > 0, record: (kind, data) => events.push({ kind, ...data }),
        fetchImpl: async (url, options) => {
            sends++;
            expect(url).toBe('https://firebasevertexai.googleapis.com/v1beta/projects/test-project/models/test-model:generateContent');
            expect(options.headers.Authorization).toBe('Firebase secret-user-token');
            expect(options.redirect).toBe('error');
            return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { totalTokenCount: 2 } }));
        } });
    const request = { uid: 'alice', requestId: 'one', category: 'chat', prompt: 'hello' };
    expect(await service.generate(request)).toEqual({ text: 'ok' });
    await expect(service.generate({ ...request, requestId: 'two' })).rejects.toThrow('inference_budget_exhausted');
    expect(sends).toBe(1);
    expect(JSON.stringify(events)).not.toContain('secret-');
});
test('Firestore preflight requires explicit bounded coverage and can verify database metadata without writes', async () => {
    const config = { profile: 'firestore-comparison', projectId: 'test-project', databaseId: 'quota-tests', inference: { provider: 'fake' }, cases: ['portable-burst'], limits: { maxRequests: 60 } };
    const invalid = await preflight({ ...config, cases: [] });
    expect(invalid.configurationValid).toBe(false);
    let calls = 0;
    const result = await preflight(config, { probe: true, credential: { getAccessToken: async () => ({ access_token: 'secret-token' }) }, fetchImpl: async (url, options) => {
            calls++;
            expect(url).toBe('https://firestore.googleapis.com/v1/projects/test-project/databases/quota-tests');
            expect(options.method).toBe('GET');
            return Response.json({ name: 'projects/test-project/databases/quota-tests', locationId: 'us-central1', type: 'FIRESTORE_NATIVE', concurrencyMode: 'PESSIMISTIC', databaseEdition: 'STANDARD' });
        } });
    expect(calls).toBe(1);
    expect(result.ready).toBe(true);
    expect(result.database).toMatchObject({ concurrencyMode: 'PESSIMISTIC', locationId: 'us-central1' });
    expect(JSON.stringify(result)).not.toContain('secret-token');
});
