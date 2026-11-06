/** Every functions-http probe, in capture order. */
import { probe as basicGet } from '../../../probes/functions-http/functions-http-onrequest-basic-get.ts';
import { probe as subpath } from '../../../probes/functions-http/functions-http-onrequest-subpath.ts';
import { probe as bodyParsing } from '../../../probes/functions-http/functions-http-onrequest-body-parsing.ts';
import { probe as malformedJson } from '../../../probes/functions-http/functions-http-onrequest-malformed-json.ts';
import { probe as responseShapes } from '../../../probes/functions-http/functions-http-onrequest-response-shapes.ts';
import { probe as handlerFailure } from '../../../probes/functions-http/functions-http-onrequest-handler-failure.ts';
import { probe as headersSentFailure } from '../../../probes/functions-http/functions-http-onrequest-headers-sent-failure.ts';
import { probe as noResponseTimeout } from '../../../probes/functions-http/functions-http-onrequest-no-response-timeout.ts';
import { probe as uncaughtAsync } from '../../../probes/functions-http/functions-http-onrequest-uncaught-async.ts';
import { probe as corsUnset } from '../../../probes/functions-http/functions-http-onrequest-cors-unset.ts';
import { probe as corsConfigured } from '../../../probes/functions-http/functions-http-onrequest-cors-configured.ts';
import { probe as invokerPrivate } from '../../../probes/functions-http/functions-http-onrequest-invoker-private.ts';
import { probe as notFound } from '../../../probes/functions-http/functions-http-onrequest-not-found.ts';
import { probe as v1 } from '../../../probes/functions-http/functions-http-onrequest-v1.ts';
import { probe as hostingRewrite } from '../../../probes/functions-http/functions-http-hosting-rewrite.ts';
import type { FunctionsHttpProbe } from './probe-types.ts';

export const functionsHttpProbes: readonly FunctionsHttpProbe[] = [
  basicGet,
  subpath,
  bodyParsing,
  malformedJson,
  responseShapes,
  handlerFailure,
  headersSentFailure,
  noResponseTimeout,
  uncaughtAsync,
  corsUnset,
  corsConfigured,
  invokerPrivate,
  notFound,
  v1,
  hostingRewrite,
];
