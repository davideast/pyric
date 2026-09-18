/** Counts remain useful when a phase times out before every call settles. */
export function summarizeBrowserWorkloads(clients) {
  const phaseMissing = clients.length === 0;
  if (phaseMissing) return null;
  const windows = clients.flatMap(client => client.windows);
  const sumClients = key => clients.reduce((sum, client) => sum + client[key], 0);
  const sumWindows = key => windows.reduce((sum, window) => sum + window[key], 0);
  return { scheduled: sumClients('scheduled'), started: sumClients('started'),
    succeeded: sumWindows('completed'), failed: sumWindows('errors'),
    skippedAtPendingLimit: sumClients('skippedAtPendingLimit'), stillPending: sumClients('stillPending'),
    accountingValid: clients.every(client => client.accountingValid),
    drainCompleted: clients.every(client => client.drainError === null) };
}

/** Runs inside one browser; windows group calls by their scheduled start time. */
export async function runBrowserWorkload({ milliseconds, client, name, ratePerClient }) {
  const sdk = await import('firebase/firestore');
  const db = sdk.getFirestore();
  const pending = new Set();
  const buckets = new Map();
  const intervalMs = 1000 / ratePerClient;
  const total = Math.round(milliseconds / intervalMs);
  const start = performance.now();
  let scheduled = 0;
  let peakPending = 0;
  let accountingValid = true;

  function bucket(sequence) {
    const window = Math.floor(sequence * intervalMs / 10_000);
    if (!buckets.has(window)) {
      buckets.set(window, { window, scheduled: 0, started: 0, skippedAtPendingLimit: 0,
        completed: 0, errors: 0, firstError: null, peakPending: 0,
        latencies: [], schedulingLateness: [] });
    }
    return buckets.get(window);
  }
  function checkAccounting() {
    let unresolved = 0;
    for (const entry of buckets.values()) {
      const scheduledMatches = entry.scheduled === entry.started + entry.skippedAtPendingLimit;
      const stillPending = entry.started - entry.completed - entry.errors;
      accountingValid &&= scheduledMatches && stillPending >= 0;
      unresolved += stillPending;
    }
    accountingValid &&= unresolved === pending.size;
  }
  while (scheduled < total) {
    const due = Math.min(total, Math.floor((performance.now() - start) / intervalMs) + 1);
    while (scheduled < due) {
      const sequence = scheduled++;
      const entry = bucket(sequence);
      entry.scheduled++;
      entry.schedulingLateness.push(Math.max(0, performance.now() - start - sequence * intervalMs));
      const atCapacity = pending.size >= 64;
      if (atCapacity) { entry.skippedAtPendingLimit++; continue; }
      const index = client * 250 + sequence % 250;
      const value = { index, sequence, padding: '' };
      value.padding = 'x'.repeat(1024 - JSON.stringify(value).length);
      const sent = performance.now();
      entry.started++;
      const operation = sdk.setDoc(sdk.doc(db, 'acceptance', String(index)), value)
        .then(() => { entry.completed++; entry.latencies.push(performance.now() - sent); })
        .catch(error => { entry.errors++; entry.firstError ??= String(error); })
        .finally(() => pending.delete(operation));
      pending.add(operation);
      peakPending = Math.max(peakPending, pending.size);
      entry.peakPending = Math.max(entry.peakPending, pending.size);
    }
    checkAccounting();
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  let timeout;
  let drainError = null;
  try {
    await Promise.race([Promise.all(pending), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Work did not drain in 10 seconds')), 10_000);
    })]);
  } catch (error) { drainError = String(error); }
  finally { clearTimeout(timeout); }
  checkAccounting();
  function percentile(values, fraction) {
    return values[Math.ceil(values.length * fraction) - 1] ?? null;
  }
  const windows = [...buckets.values()].map(entry => {
    entry.latencies.sort((a, b) => a - b);
    entry.schedulingLateness.sort((a, b) => a - b);
    const { latencies, schedulingLateness, ...counts } = entry;
    return { ...counts, stillPending: entry.started - entry.completed - entry.errors,
      p95Ms: percentile(latencies, .95), p99Ms: percentile(latencies, .99), maxMs: latencies.at(-1) ?? null,
      schedulingP95Ms: percentile(schedulingLateness, .95), schedulingMaxMs: schedulingLateness.at(-1) ?? null };
  });
  const sum = key => windows.reduce((count, entry) => count + entry[key], 0);
  return { client, phase: name, scheduled, started: sum('started'), skippedAtPendingLimit: sum('skippedAtPendingLimit'),
    stillPending: pending.size, accountingValid, peakPending, drainError, elapsedMs: performance.now() - start, windows };
}
