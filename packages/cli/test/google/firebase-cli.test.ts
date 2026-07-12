import { describe, expect, it, mock } from 'bun:test';

import { fromFirebaseCli } from '../../src/google/firebase-cli.js';

const CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';

describe('Firebase CLI credential adapter', () => {
  it('uses a valid cached access token without refreshing it', async () => {
    const fetch = mock(async () => new Response(null, { status: 500 }));
    const access = await fromFirebaseCli('demo-project', {}, {
      now: () => 1_000,
      fetch,
      readConfig: async () => ({
        tokens: {
          access_token: 'cached-token',
          refresh_token: 'refresh-token',
          expires_at: 3_601_000,
        },
      }),
    });

    expect(access).not.toBeNull();
    expect(await access!.resolveToken()).toBe('cached-token');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes with the Firebase CLI OAuth client without writing credentials', async () => {
    const fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe(CLIENT_ID);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('firebase-refresh-token');
      return Response.json({ access_token: 'fresh-token', expires_in: 3600 });
    });
    const access = await fromFirebaseCli('demo-project', {}, {
      fetch,
      readConfig: async () => ({
        tokens: { refresh_token: 'firebase-refresh-token' },
      }),
    });

    expect(access).not.toBeNull();
    expect(await access!.resolveToken()).toBe('fresh-token');
  });

  it('returns null when the Firebase CLI has no default login', async () => {
    expect(
      await fromFirebaseCli('demo-project', {}, { readConfig: async () => null }),
    ).toBeNull();
  });
});
