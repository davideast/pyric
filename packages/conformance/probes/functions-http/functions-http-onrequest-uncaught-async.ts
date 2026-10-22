import { statusShape, type FunctionsHttpProbe, type ProbeResponse } from '../../src/capture/functions-http/probe-types.ts';

const instanceOf = (response: ProbeResponse): string | null =>
  (response.json as { instanceId?: string } | null)?.instanceId ?? null;

/**
 * functions-http#12: an exception thrown from a timer, outside the handler's
 * own call and promise, after the response and before it. `whoami` requests
 * around each throw tell whether the same process kept serving.
 */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-uncaught-async',
  matrixRow: 'functions-http #12',
  rowIds: ['functions-http#12'],
  description:
    'A v2 onRequest handler (maxInstances: 1) that throws from a setTimeout after responding, and one that throws before responding; the responses and whether the serving instance changed.',
  requests: [
    { id: 'whoami-start', function: 'pyricHttpUncaught', via: 'cloudfunctions' },
    { id: 'after-response', function: 'pyricHttpUncaught', via: 'cloudfunctions', path: '?mode=after-response' },
    { id: 'whoami-after', function: 'pyricHttpUncaught', via: 'cloudfunctions', delayBeforeMs: 5_000 },
    { id: 'before-response', function: 'pyricHttpUncaught', via: 'cloudfunctions', path: '?mode=before-response', clientTimeoutMs: 120_000 },
    { id: 'whoami-end', function: 'pyricHttpUncaught', via: 'cloudfunctions', delayBeforeMs: 5_000 },
  ],
  behavior(responses) {
    const start = instanceOf(responses['whoami-start']);
    return {
      afterResponse: {
        status: responses['after-response'].status,
        servedByStartInstance: instanceOf(responses['after-response']) === start,
      },
      nextRequestAfterThrow: {
        status: responses['whoami-after'].status,
        sameInstance: instanceOf(responses['whoami-after']) === start,
      },
      beforeResponse: statusShape(responses['before-response']),
      nextRequestAfterUnansweredThrow: {
        status: responses['whoami-end'].status,
        sameInstanceAsAfter: instanceOf(responses['whoami-end']) === instanceOf(responses['whoami-after']),
      },
    };
  },
};
