import { row } from './section.ts';

export default row({
  order: 170,
  kind: 'observed',
  api: 'firebase.json hosting.rewrites[].function',
  behavior:
    "A hosting rewrite to a function routes the full original path and query, honors { functionId, region }, takes the region from the function's source when the rewrite names none (us-central1 only when the source names none either), cuts the request at Hosting's 60 s, and forwards only the __session cookie.",
  evidence:
    'upstream: firebase-tools appends the original req.url and sets X-Forwarded-Host and X-Original-Url (`lib/hosting/functionsProxy.js:20-31`, `lib/hosting/proxy.js:29-50`). The `__session`-only cookie rule comes from the Hosting docs (https://firebase.google.com/docs/hosting/manage-cache#using_cookies); the emulator forwards every cookie, because `proxy.js` copies the full Cookie header after setting `__session`. Production behavior needs `functions-http-hosting-rewrite`.',
});
