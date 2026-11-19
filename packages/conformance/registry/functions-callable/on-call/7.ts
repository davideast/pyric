import { CLIENT, row } from './section.ts';

export default row({
  order: 70,
  kind: 'observed',
  api: 'request.auth (v2), context.auth (v1)',
  behavior:
    'With no Authorization header the call is served, and v2 request.auth and v1 context.auth are undefined. After signOut the client SDK sends no Authorization header.',
  evidence:
    'upstream: a missing header is `MISSING`, which refuses nothing (`:309-312`, `:441-443`); the client adds the header only when Auth returns a token (' +
    CLIENT +
    ' `makeAuthHeaders`). Production behavior needs `functions-callable-auth-missing` and `functions-callable-client-signed-in`.',
});
