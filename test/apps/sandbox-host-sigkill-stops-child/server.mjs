import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const portArg = Number(process.argv[2]);
const pidFile = process.argv[3];

initializeApp({ projectId: 'demo-sandbox-lifecycle' });
const db = getFirestore();

const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
    return;
  }
  try {
    await db.doc('items/boot').set({ status: 'ready', pid: process.pid });
    const snap = await db.doc('items/boot').get();
    const data = snap.data() ?? {};
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid, status: data.status ?? null }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: message }));
  }
});

process.on('SIGTERM', () => {
  process.stdout.write('child server stopping on SIGTERM\n');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});

server.listen(portArg, '127.0.0.1', () => {
  if (typeof pidFile === 'string' && pidFile.length > 0) {
    writeFileSync(pidFile, `${process.pid}\n`);
  }
  process.stdout.write(`child listening on ${portArg} pid=${process.pid}\n`);
});
