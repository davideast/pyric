// A dev proxy that builds its upstream request from `req.rawHeaders`, the way a
// framework adapter that keeps the client's header casing does. It forwards to
// the sandbox host named in PYRIC_SANDBOX, for requests and for socket upgrades.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';

const target = new URL(process.env.PYRIC_SANDBOX.replace(/^remote:/, ''));
const port = Number(process.argv[2]);
const upstreamHost = target.hostname === 'localhost' ? '127.0.0.1' : target.hostname;

const server = createServer((req, res) => {
  const upstream = request({ host: upstreamHost, port: target.port, path: req.url, method: req.method, headers: req.rawHeaders }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => res.writeHead(502).end());
  req.pipe(upstream);
});

server.on('upgrade', (req, socket) => {
  const upstream = connect(Number(target.port), upstreamHost, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let name = 0; name < req.rawHeaders.length; name += 2) lines.push(`${req.rawHeaders[name]}: ${req.rawHeaders[name + 1]}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(port, '0.0.0.0', () => console.log(`raw proxy listening on ${port}`));
