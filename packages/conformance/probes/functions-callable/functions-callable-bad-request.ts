import {
  callableShape,
  type CallableProbeRequest,
  type FunctionsCallableWireProbe,
} from '../../src/capture/functions-callable/probe-types.ts';

const JSON_TYPE = { 'content-type': 'application/json' };

const request = (id: string, extra: Partial<CallableProbeRequest>): CallableProbeRequest => ({
  id,
  function: 'pyricCallableEcho',
  via: 'cloudfunctions',
  ...extra,
});

/**
 * functions-callable#5: requests the callable protocol refuses with 400
 * `INVALID_ARGUMENT` "Bad Request", next to two it accepts (a charset
 * parameter, and `data: null`).
 */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-bad-request',
  matrixRow: 'functions-callable #5',
  rowIds: ['functions-callable#5'],
  description:
    'GET and PUT, a text/plain POST, a POST with no body, {} with no data, {data, extra}, malformed JSON, and the accepted charset and data: null forms.',
  requests: [
    request('get', { method: 'GET' }),
    request('put', { method: 'PUT', headers: JSON_TYPE, body: '{"data":1}' }),
    request('text-plain', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"data":1}' }),
    request('no-body', { method: 'POST', headers: JSON_TYPE }),
    request('missing-data', { method: 'POST', headers: JSON_TYPE, body: '{}' }),
    request('extra-keys', { method: 'POST', headers: JSON_TYPE, body: '{"data":1,"extra":true}' }),
    request('malformed-json', { method: 'POST', headers: JSON_TYPE, body: '{"data":' }),
    request('charset', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"data":1}' }),
    request('data-null', { method: 'POST', headers: JSON_TYPE, body: '{"data":null}' }),
  ],
  behavior(responses) {
    return Object.fromEntries(Object.keys(responses).map((id) => [id, callableShape(responses[id])]));
  },
};
