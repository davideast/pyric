import { CLIENT, row } from './section.ts';

export default row({
  order: 170,
  kind: 'observed',
  api: 'firebase.json hosting.rewrites[].function to a callable',
  behavior:
    'A hosting rewrite { source, function } to a callable serves the callable protocol on the Hosting origin: a POST answers {"result"}, an HttpsError answers its status and {"error"} body, and a GET answers 400 Bad Request. getFunctions(app, origin) with that origin calls <origin>/<name> and returns the result.',
  evidence:
    `upstream: \`FunctionsService._url\` builds \`\${customDomain}/\${name}\` (${CLIENT}). The rewrite and its forwarding follow functions-http#17. Production behavior needs \`functions-callable-hosting-rewrite\` and \`functions-callable-client-custom-domain\`.`,
});
