import { describe, expect, test } from 'bun:test';

describe('inferenceApi Firebase endpoint', () => {
  test('publishes the Gen 2 runtime contract firebase-tools deploys', async () => {
    process.env.DEPLOY_SA_JSON_BASE64 = Buffer.from(
      JSON.stringify({
        project_id: 'test-project',
        client_email: 'test@example.invalid',
        private_key: 'not-used-by-endpoint-discovery',
      }),
    ).toString('base64');
    const { inferenceApi } = await import('./index');
    const endpoint = (inferenceApi as typeof inferenceApi & {
      __endpoint?: Record<string, unknown>;
    }).__endpoint;

    expect(endpoint).toMatchObject({
      platform: 'gcfv2',
      region: ['us-central1'],
      availableMemoryMb: 1024,
      timeoutSeconds: 300,
      minInstances: 1,
      maxInstances: 1,
      concurrency: 80,
      cpu: 1,
      httpsTrigger: { invoker: ['public'] },
    });
  });
});
