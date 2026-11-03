/** Every functions-callable probe, in capture order: wire probes, then page scenarios. */
import { probe as dataRoundtrip } from '../../../probes/functions-callable/functions-callable-data-roundtrip.ts';
import { probe as encoding } from '../../../probes/functions-callable/functions-callable-encoding.ts';
import { probe as httpsErrorCodes } from '../../../probes/functions-callable/functions-callable-https-error-codes.ts';
import { probe as plainThrow } from '../../../probes/functions-callable/functions-callable-plain-throw.ts';
import { probe as badRequest } from '../../../probes/functions-callable/functions-callable-bad-request.ts';
import { probe as authValid } from '../../../probes/functions-callable/functions-callable-auth-valid.ts';
import { probe as authMissing } from '../../../probes/functions-callable/functions-callable-auth-missing.ts';
import { probe as authInvalid } from '../../../probes/functions-callable/functions-callable-auth-invalid.ts';
import { probe as appCheckEnforced } from '../../../probes/functions-callable/functions-callable-app-check-enforced.ts';
import { probe as appCheckUnenforced } from '../../../probes/functions-callable/functions-callable-app-check-unenforced.ts';
import { probe as appCheckConsume } from '../../../probes/functions-callable/functions-callable-app-check-consume.ts';
import { probe as cors } from '../../../probes/functions-callable/functions-callable-cors.ts';
import { probe as streaming } from '../../../probes/functions-callable/functions-callable-streaming.ts';
import { probe as v1 } from '../../../probes/functions-callable/functions-callable-v1.ts';
import { probe as hostingRewrite } from '../../../probes/functions-callable/functions-callable-hosting-rewrite.ts';
import { probe as clientEncoding } from '../../../probes/functions-callable/functions-callable-client-encoding.ts';
import { probe as clientErrors } from '../../../probes/functions-callable/functions-callable-client-errors.ts';
import { probe as clientFromUrl } from '../../../probes/functions-callable/functions-callable-client-from-url.ts';
import { probe as clientCustomDomain } from '../../../probes/functions-callable/functions-callable-client-custom-domain.ts';
import { probe as clientLimitedUse } from '../../../probes/functions-callable/functions-callable-client-limited-use.ts';
import { probe as clientStream } from '../../../probes/functions-callable/functions-callable-client-stream.ts';
import { probe as clientSignedIn } from '../../../probes/functions-callable/functions-callable-client-signed-in.ts';
import type { FunctionsCallableProbe } from './probe-types.ts';

export const functionsCallableProbes: readonly FunctionsCallableProbe[] = [
  dataRoundtrip,
  encoding,
  httpsErrorCodes,
  plainThrow,
  badRequest,
  authValid,
  authMissing,
  authInvalid,
  appCheckEnforced,
  appCheckUnenforced,
  appCheckConsume,
  cors,
  streaming,
  v1,
  hostingRewrite,
  clientEncoding,
  clientErrors,
  clientFromUrl,
  clientCustomDomain,
  clientLimitedUse,
  clientStream,
  clientSignedIn,
];
