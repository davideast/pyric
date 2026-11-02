import type { FunctionsHttpProbe, ProbeResponse } from '../../src/capture/functions-http/probe-types.ts';

function refusal(response: ProbeResponse): Record<string, unknown> {
  return {
    status: response.status,
    contentType: response.headers['content-type'] ?? null,
    wwwAuthenticate: response.headers['www-authenticate'] ?? null,
    reachedHandler: (response.json as { instanceId?: string } | null)?.instanceId !== undefined,
    bodyMentionsForbidden: /forbidden/i.test(response.body),
  };
}

/** functions-http#15: production refuses an unauthenticated call to an `invoker: 'private'` function. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-invoker-private',
  matrixRow: 'functions-http #15',
  rowIds: ['functions-http#15'],
  description:
    'An unauthenticated GET to a v2 onRequest function deployed with invoker: private, on both production URLs.',
  requests: [
    { id: 'cloudfunctions', function: 'pyricHttpPrivate', via: 'cloudfunctions' },
    { id: 'run', function: 'pyricHttpPrivate', via: 'run' },
  ],
  behavior(responses) {
    return { cloudfunctions: refusal(responses.cloudfunctions), run: refusal(responses.run) };
  },
};
