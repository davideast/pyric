import { echoOf, type FunctionsHttpProbe, type ProbeRequest } from '../../src/capture/functions-http/probe-types.ts';

const post = (id: string, body: Partial<ProbeRequest>): ProbeRequest => ({
  id,
  function: 'pyricHttpEcho',
  via: 'cloudfunctions',
  method: 'POST',
  ...body,
});

const requests: ProbeRequest[] = [
  post('json', { headers: { 'content-type': 'application/json' }, body: '{"a":1,"b":[true,null],"c":{"d":"e"}}' }),
  post('json-charset', { headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"accent":"café"}' }),
  post('cloudevents-json', { headers: { 'content-type': 'application/cloudevents+json' }, body: '{"specversion":"1.0"}' }),
  post('vendor-json', { headers: { 'content-type': 'application/vnd.api+json' }, body: '{"data":1}' }),
  post('text', { headers: { 'content-type': 'text/plain' }, body: 'hello text' }),
  post('urlencoded', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a[b]=1&c=2&c=3&d=%20space' }),
  post('octet-stream', { headers: { 'content-type': 'application/octet-stream' }, bodyBase64: 'AAEC/w==' }),
  post('unknown-type', { headers: { 'content-type': 'application/x-pyric-unknown' }, body: 'opaque' }),
  post('no-content-type', { bodyBase64: 'cHlyaWM=' }),
  post('empty-json', { headers: { 'content-type': 'application/json' }, body: '' }),
  post('empty', {}),
];

/** functions-http#5 and #6: how each request body reaches `req.body` and `req.rawBody`. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-body-parsing',
  matrixRow: 'functions-http #5, #6',
  rowIds: ['functions-http#5', 'functions-http#6'],
  description:
    'POST bodies of each content type (JSON variants, text, urlencoded, octet-stream, unknown, none, empty) as req.body and req.rawBody in a v2 onRequest handler.',
  requests,
  behavior(responses) {
    return Object.fromEntries(
      requests.map(({ id }) => {
        const response = responses[id];
        const echo = response.status === 200 ? echoOf(response) : null;
        return [id, {
          status: response.status,
          contentTypeSeen: echo?.headerValues['content-type'] ?? null,
          bodyType: echo?.bodyType ?? null,
          body: echo?.body ?? null,
          rawBody: echo?.rawBody ?? null,
        }];
      }),
    );
  },
};
