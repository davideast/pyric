import { test, expect } from 'bun:test';
import { identifyAccessToken } from '../google-api.mjs';

test('ADC token introspection identifies users and service accounts without putting tokens in URLs', async () => {
    for (const [email, principal] of [
        ['reader@example.com', 'user:reader@example.com'],
        ['reader@test-project.iam.gserviceaccount.com', 'serviceAccount:reader@test-project.iam.gserviceaccount.com'],
    ]) {
        const identity = await identifyAccessToken('test-token', async (url, options) => {
            expect(url).toBe('https://oauth2.googleapis.com/tokeninfo');
            expect(options.method).toBe('POST');
            expect(options.headers.authorization).toBe('Bearer test-token');
            expect(options.redirect).toBe('error');
            return Response.json({ email });
        });
        expect(identity).toBe(principal);
    }
});

test('unavailable or incomplete token identity stays unknown without exposing credential errors', async () => {
    const outcomes = [
        async () => Response.json({ scope: 'cloud-platform' }),
        async () => new Response('token rejected', { status: 403 }),
        async () => { throw new Error('request with secret test-token failed'); },
    ];
    for (const fetchImpl of outcomes) expect(await identifyAccessToken('test-token', fetchImpl)).toBe('unresolved-application-default-credentials');
});
