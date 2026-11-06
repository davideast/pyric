import {
  callableBody,
  callableShape,
  parseSseFrames,
  type FunctionsCallableWireProbe,
  type ProbeResponse,
} from '../../src/capture/functions-callable/probe-types.ts';

const EVENT_STREAM = { 'content-type': 'application/json', accept: 'text/event-stream' };

function streamed(response: ProbeResponse): Record<string, unknown> {
  return {
    status: response.status,
    contentType: response.headers['content-type'] ?? null,
    transferEncoding: response.headers['transfer-encoding'] ?? null,
    frames: parseSseFrames(response.body),
    error: response.error,
  };
}

/**
 * functions-callable#14: a streaming v2 callable answers 200 with
 * `data: {"message":...}` frames, a final `data: {"result":...}` frame, an
 * error frame after a failure, and `: ping` heartbeats; without the exact
 * `Accept: text/event-stream` header it answers plain JSON.
 */
export const probe: FunctionsCallableWireProbe = {
  kind: 'wire',
  name: 'functions-callable-streaming',
  matrixRow: 'functions-callable #14',
  rowIds: ['functions-callable#14'],
  description:
    'An onCall with heartbeatSeconds: 1 that sends three chunks and pauses 2.5 s before its result; the same call failing after one chunk; and the call with no Accept header and with Accept: text/event-stream, */*.',
  requests: [
    { id: 'stream', function: 'pyricCallableStream', via: 'cloudfunctions', ...callableBody({ pauseMs: 2500 }), headers: EVENT_STREAM },
    { id: 'stream-error', function: 'pyricCallableStream', via: 'cloudfunctions', ...callableBody({ mode: 'throw' }), headers: EVENT_STREAM },
    { id: 'no-accept', function: 'pyricCallableStream', via: 'cloudfunctions', ...callableBody({}) },
    {
      id: 'accept-list',
      function: 'pyricCallableStream',
      via: 'cloudfunctions',
      ...callableBody({}),
      headers: { 'content-type': 'application/json', accept: 'text/event-stream, */*' },
    },
  ],
  behavior(responses) {
    return {
      stream: streamed(responses.stream),
      streamError: streamed(responses['stream-error']),
      noAccept: callableShape(responses['no-accept']),
      acceptList: callableShape(responses['accept-list']),
    };
  },
};
