/**
 * What the auth surface puts on the sandbox event stream.
 *
 * The sandbox core reads this record to derive the `auth` arm of
 * `ServiceMutationEvent`; the emit sites in `auth/sandbox-backend.ts` are
 * typed against the operations declared here.
 */
import type { ServiceEventRecord } from '../sandbox/types/service-event-record.js';

export const AUTH_EVENT_RECORD = {
  service: 'auth',
  operations: [
    'user_create',
    'user_update',
    'user_delete',
    'users_clear',
    'sign_in',
    'sign_out',
    'provider_config_update',
  ],
  target: {
    name: 'uid',
    description: "The mutated user's uid, or '*' when every user was cleared.",
    always: false,
  },
} as const satisfies ServiceEventRecord;

/** Every operation the auth surface emits. */
export type AuthEventOperation = (typeof AUTH_EVENT_RECORD)['operations'][number];
