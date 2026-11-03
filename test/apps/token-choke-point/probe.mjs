// Run as `pyric sandbox -- node probe.mjs <credentials|ai>`. Each probe does
// what a Google library does in a user's server code, and records the error
// code it got, or what it got back. It prints one JSON line starting with
// `{"probe"`. trap.cjs sends every connection the guard lets through to a
// closed local port, and the line lists the hosts it trapped.

/** The guard's code, or the first code on the error's cause chain, or its message. */
function codeOf(error) {
  let first;
  for (let current = error; current; current = current.cause) {
    if (current.code === 'PYRIC_GUARD_BLOCKED') return current.code;
    first ??= current.code;
  }
  return first ?? String(error?.message ?? error);
}

async function outcome(run) {
  try {
    return { resolved: await run() };
  } catch (error) {
    return { rejected: codeOf(error) };
  }
}

async function credentialProbes() {
  const { GoogleAuth } = await import('google-auth-library');
  const gcpMetadata = await import('gcp-metadata');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  return {
    accessToken: await outcome(async () => (await auth.getAccessToken()) ? 'token' : 'no token'),
    metadataInstance: await outcome(() => gcpMetadata.instance('id')),
    metadataAvailable: await outcome(() => gcpMetadata.isAvailable()),
    fonts: await outcome(async () => (await fetch('https://fonts.googleapis.com/css2?family=Roboto')).status),
  };
}

async function aiProbe() {
  const { initializeApp } = await import('firebase/app');
  const { getAI, getGenerativeModel, VertexAIBackend } = await import('firebase/ai');
  const app = initializeApp({
    apiKey: 'AIzaSyDemoKeyForReproOnly000000000000',
    projectId: 'my-real-project',
    appId: '1:000000000000:web:0000000000000000000000',
  });
  const model = getGenerativeModel(getAI(app, { backend: new VertexAIBackend() }), { model: 'gemini-3.5-flash-lite' });
  return { generate: await outcome(async () => (await model.generateContent('ping')).response.text()) };
}

const probe = process.argv[2];
const results = probe === 'ai' ? await aiProbe() : await credentialProbes();
const trapped = globalThis[Symbol.for('scenario.trapped')] ?? null;
console.log(JSON.stringify({ probe, results, trapped }));
