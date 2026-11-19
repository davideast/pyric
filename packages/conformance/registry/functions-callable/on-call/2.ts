import { CLIENT, row } from './section.ts';

export default row({
  order: 20,
  kind: 'observed',
  api: 'callable data encoding',
  behavior:
    'Request data: an Int64Value or UInt64Value {"@type", value} wrapper decodes to a JavaScript number (so precision past 2^53 is lost); a wrapper whose value is not a number, and any other @type, answer 500 INTERNAL. Result data: a Date encodes as {} on the server, NaN and Infinity cannot be encoded and answer 500 INTERNAL, and an integer above 2^53 is sent as a plain JSON number. Client side: httpsCallable sends a Date as its ISO string and undefined data as null, and rejects NaN and Infinity in request data before sending.',
  evidence: `upstream: server \`encode\` and \`decode\` (\`:156-230\`) run inside the handler's try, so their throws become INTERNAL (\`:528-534\`); client \`encode\` and \`decode\` in ${CLIENT} (\`:41-108\`). Production behavior needs \`functions-callable-encoding\` and \`functions-callable-client-encoding\`.`,
});
