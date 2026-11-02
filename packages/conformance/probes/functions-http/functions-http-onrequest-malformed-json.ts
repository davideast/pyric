import { statusShape, type FunctionsHttpProbe } from '../../src/capture/functions-http/probe-types.ts';

/** functions-http#7: a JSON body that does not parse is refused before the handler runs. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-malformed-json',
  matrixRow: 'functions-http #7',
  rowIds: ['functions-http#7'],
  description:
    'A POST with content-type application/json and a body that does not parse, answered by production before the echo handler runs.',
  requests: [
    {
      id: 'truncated',
      function: 'pyricHttpEcho',
      via: 'cloudfunctions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":',
    },
    {
      id: 'not-json',
      function: 'pyricHttpEcho',
      via: 'cloudfunctions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    },
  ],
  behavior(responses) {
    return {
      truncated: { ...statusShape(responses.truncated), reachedHandler: responses.truncated.json !== null },
      notJson: { ...statusShape(responses['not-json']), reachedHandler: responses['not-json'].json !== null },
    };
  },
};
