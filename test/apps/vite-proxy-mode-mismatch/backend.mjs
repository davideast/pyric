// The app's API: a plain http server with no Firebase import. The scenario
// starts it under `pyric run --sandbox`, under @pyric/live/register, and
// bare, so the only difference between the three is the process around it.
import { createServer } from "node:http";

const name = process.env.BACKEND_NAME ?? "backend";
const port = Number(process.env.BACKEND_PORT);

const server = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ backend: name, path: request.url }));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`${name} backend listening on ${port}`);
});
