import { row } from './section.ts';

export default row({
  order: 80,
  kind: 'observed',
  api: 'res.status, res.set, res.json, res.redirect, res.cookie, res.write',
  behavior:
    'Status codes, headers, JSON bodies, redirects, cookies, empty responses, and streamed res.write chunks arrive unchanged, with no x-powered-by header.',
  evidence:
    'upstream: functions-framework-nodejs disables `x-powered-by`. Production behavior needs `functions-http-onrequest-response-shapes`.',
});
