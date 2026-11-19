import { CLIENT, row } from './section.ts';

export default row({
  order: 140,
  kind: 'observed',
  api: 'request.acceptsStreaming, response.sendChunk',
  behavior:
    'With Accept exactly text/event-stream, a v2 callable answers 200 with each sendChunk(x) as a data: {"message": x} frame, then a data: {"result": ...} frame, and a ": ping" comment every heartbeatSeconds (30 when unset) while no chunk is sent. A throw after the stream began sends a data: {"error": {...}} frame on the same 200 response. Without that exact header (none, or text/event-stream, */*), acceptsStreaming is false, sendChunk resolves false, and the answer is plain JSON. The client .stream() yields each message, resolves data with the result, and rejects both on an error frame.',
  evidence: `upstream: \`wrapOnCallHandler\` streaming path (\`:392-548\`), \`DEFAULT_HEARTBEAT_SECONDS = 30\` (\`:19\`); client \`streamAtURL\` and \`createResponseStream\` in ${CLIENT}. Owner decision functions-6: served if the SDK's stream passes through the proxy unbuffered, otherwise unsupported with a reason. Production behavior needs \`functions-callable-streaming\` and \`functions-callable-client-stream\`.`,
});
