import { statusShape, type FunctionsHttpProbe } from '../../src/capture/functions-http/probe-types.ts';

/** functions-http#16: a request for a function name the project does not deploy. */
export const probe: FunctionsHttpProbe = {
  name: 'functions-http-onrequest-not-found',
  matrixRow: 'functions-http #16',
  rowIds: ['functions-http#16'],
  description:
    'A GET to a cloudfunctions.net function name the project never deployed, with and without a path after it.',
  requests: [
    { id: 'missing', function: 'pyricHttpMissing', via: 'cloudfunctions' },
    { id: 'missing-subpath', function: 'pyricHttpMissing', via: 'cloudfunctions', path: '/a/b' },
  ],
  behavior(responses) {
    return { missing: statusShape(responses.missing), missingSubpath: statusShape(responses['missing-subpath']) };
  },
};
