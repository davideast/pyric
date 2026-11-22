// Minimal Node HTTP stand-in for the Gemini SSE upstream (#1633).
// Runs in a real Node process so `res.on('close')` observes raw TCP
// disconnects both before headers are sent and mid-stream without runtime shim quirks.
import { createServer } from 'node:http';

const TOTAL_CHUNKS = 40;
const CHUNK_INTERVAL_MS = 150;
const SLOW_HEADERS_DELAY_MS = 15000;
const records = [];

function makeChunkPayload(index) {
  const candidate = {
    index: 0,
    content: { role: 'model', parts: [{ text: `c${index} ` }] },
  };
  if (index === TOTAL_CHUNKS - 1) {
    candidate.finishReason = 'STOP';
  }
  return `data: ${JSON.stringify({
    candidates: [candidate],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: index + 1, totalTokenCount: index + 3 },
    modelVersion: 'gemini-2.5-flash',
  })}\r\n\r\n`;
}

const server = createServer((request, response) => {
  const path = request.url ?? '';
  if (request.method === 'GET' && path === '/_records') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(records));
    return;
  }

  const isSlowHeaders = path.includes('/models/gemini-slow-headers:');
  request.resume();
  request.on('end', () => {
    if (isSlowHeaders) {
      const record = {
        kind: 'slow-headers',
        chunksWritten: 0,
        headersSent: false,
        disconnected: false,
        done: false,
      };
      records.push(record);
      const timer = setTimeout(() => {
        if (record.disconnected || response.destroyed || response.writableEnded) return;
        record.headersSent = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        record.chunksWritten = 1;
        response.end(makeChunkPayload(TOTAL_CHUNKS - 1));
        record.done = true;
      }, SLOW_HEADERS_DELAY_MS);
      response.on('close', () => {
        clearTimeout(timer);
        if (!response.writableEnded) {
          record.disconnected = true;
        }
      });
      return;
    }

    const record = {
      kind: 'stream',
      chunksWritten: 0,
      headersSent: true,
      disconnected: false,
      done: false,
    };
    records.push(record);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    let index = 0;
    let timer;
    const writeOne = () => {
      if (record.disconnected || response.destroyed || response.writableEnded) return;
      response.write(makeChunkPayload(index));
      record.chunksWritten += 1;
      index += 1;
      if (index >= TOTAL_CHUNKS) {
        record.done = true;
        response.end();
        return;
      }
      timer = setTimeout(writeOne, CHUNK_INTERVAL_MS);
    };
    response.on('close', () => {
      if (timer !== undefined) clearTimeout(timer);
      if (!response.writableEnded) {
        record.disconnected = true;
      }
    });
    writeOne();
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`STAND_IN_READY http://127.0.0.1:${port}`);
});
