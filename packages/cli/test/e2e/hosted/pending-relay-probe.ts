import { disconnectClient, getFirestore, relayWorkerOp } from '@pyric/cli/serve/worker';

const result = document.createElement('output');
result.id = 'relay-capacity-result';
document.body.append(result);

async function run(): Promise<void> {
  const db = getFirestore('/pending-relay-worker.js', 'capacity-wire-counterpart');
  let summary = '';
  try {
    const pending = Array.from({ length: 256 }, () =>
      relayWorkerOp(db, { method: 'getDoc', path: 'shared/greeting' }, 'busy').catch(errorCode));
    const excess = await relayWorkerOp(db, { method: 'getDoc', path: 'shared/greeting' }, 'busy').catch(errorCode);
    const healthy = await relayWorkerOp(db, { method: 'getDoc', path: 'shared/greeting' }, 'healthy');
    await relayWorkerOp(db, { method: 'getVersion' }, 'release');
    const completed = await Promise.all(pending);
    const next = await relayWorkerOp(db, { method: 'getDoc', path: 'shared/greeting' }, 'busy');
    summary = JSON.stringify({ excess, healthy, completed, next });
  } finally {
    await disconnectClient(db);
  }
  result.textContent = summary;
}

function errorCode(error: unknown): unknown {
  const hasCode = error !== null && typeof error === 'object' && 'code' in error;
  return hasCode ? error.code : String(error);
}

void run().catch(error => { result.textContent = JSON.stringify({ error: errorCode(error) }); });
