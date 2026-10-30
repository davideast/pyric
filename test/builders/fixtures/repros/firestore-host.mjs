// A repro script for the fake builder's Google-host event: the same fetch to
// Cloud Firestore from Node. The recorder refuses it; the reproduction is
// judged by the network record, not by this script's exit code.
try {
  await fetch('https://firestore.googleapis.com/v1/projects/demo-fake/databases/(default)/documents', { signal: AbortSignal.timeout(10_000) });
  console.log('fetch succeeded');
} catch (error) {
  console.log(`fetch failed: ${error.cause?.code ?? error.code ?? error.message}`);
}
