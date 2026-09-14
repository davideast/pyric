import { flowRules, securityScenarios, securityIdentity, type ProjectDocument } from './security-scenarios.ts';
import { createListenerMode, type ListenerMode } from '../../packages/cli/src/serve/runtime/listener-mode.ts';
import { mountPyricRuntimeChip } from '../../packages/cli/src/serve/runtime/chip.ts';
import { createPyricRuntimeStatus } from '../../packages/cli/src/serve/runtime/status.ts';
import { installReactCommitSource } from '../../packages/cli/src/serve/runtime/react-commit-source.ts';
import type { SandboxEvent } from 'pyric/sandbox';

// Install the real commit hook before React evaluates.
const commits = installReactCommitSource(window);
const reactModule = await import('react');
const React = reactModule.default ?? reactModule;
const clientModule = await import('react-dom/client');
const { createRoot } = clientModule.default ?? clientModule;
const h = React.createElement;
const kind = new URL(location.href).searchParams.get('runtime') ?? 'inpage';
let subscribeEvents: (listener: (events: readonly SandboxEvent[]) => void) => () => void;
let readDocument: () => Promise<unknown>;
let readQuery: () => Promise<unknown>;
let readDatabase: () => Promise<unknown>;
let listenDocument: (next: (data: unknown) => void) => () => void;
let listenDatabase: (next: (data: unknown) => void) => () => void;
let write: () => Promise<void>;
let denied: () => Promise<unknown>;
let deniedWrite: () => Promise<unknown>;
let readProject: (path: string) => Promise<unknown>;
let updateProject: (path: string, value: ProjectDocument) => Promise<unknown>;
let version = 0;
if (kind === 'worker') {
  const sdk = await import('../../packages/cli/src/serve/worker/client.ts');
  const database = await import('../../packages/cli/src/serve/worker/client/rtdb-references.ts');
  const reads = await import('../../packages/cli/src/serve/worker/client/rtdb-reads.ts');
  const writes = await import('../../packages/cli/src/serve/worker/client/rtdb-writes.ts');
  const listeners = await import('../../packages/cli/src/serve/worker/client/rtdb-listeners.ts');
  const db = sdk.getFirestore('/sdk-worker.js', 'sdk-flow-example', { onError: error => { globalThis.document.body.dataset.workerError = error.message; console.error(error); } });
  const asAlice = async <T,>(operation: () => Promise<T>): Promise<T> => {
    const previous = sdk.getLens();
    sdk.setLens({ mode: 'as', ...securityIdentity });
    try { return await operation(); } finally { sdk.setLens(previous); }
  };
  readProject = path => asAlice(async () => (await sdk.getDoc(sdk.doc(db, path))).data());
  updateProject = (path, value) => asAlice(() => sdk.setDoc(sdk.doc(db, path), { ...value }));
  const document = sdk.doc(db, 'messages/current');
  const node = database.rtdbRef(database.rtdbGetDatabase(db), 'messages/current');
  readDocument = async () => (await sdk.getDoc(document)).data();
  readQuery = async () => (await sdk.getDocs(sdk.query(sdk.collection(db, 'messages')))).docs.map(doc => doc.data());
  readDatabase = async () => (await reads.rtdbGet(node)).val();
  listenDocument = next => sdk.onSnapshot(document, snap => next((snap as { data(): unknown }).data()));
  listenDatabase = next => listeners.rtdbOnValue(node, snap => next(snap.val()));
  write = async () => { ++version; await sdk.setDoc(document, { version }); await writes.rtdbSet(node, { version }); };
  denied = () => sdk.getDoc(sdk.doc(db, 'private/denied'));
  deniedWrite = () => sdk.setDoc(document, { version: -1 });
  subscribeEvents = listener => sdk.subscribeEvents(db, listener);
} else {
  const { initializeSandbox } = await import('pyric/sandbox');
  const { setRules } = await import('pyric/sandbox/firestore');
  const sdk = await import('pyric/firestore');
  const database = await import('pyric/database');
  const sandbox = initializeSandbox();
  setRules(sandbox, flowRules);
  for (const scenario of securityScenarios) sandbox.admin.setDocument(scenario.path, { ...scenario.project });
  const db = sdk.getFirestore(sandbox);
  const rtdb = database.getDatabase(sandbox);
  database.sandbox.setDefaultPolicy(rtdb, 'allow');
  const signedInDb = sdk.getFirestore(sandbox.withAuth(securityIdentity));
  readProject = async path => (await sdk.getDoc(sdk.doc(signedInDb, path))).data();
  updateProject = (path, value) => sdk.setDoc(sdk.doc(signedInDb, path), { ...value });
  const document = sdk.doc(db, 'messages/current');
  const node = database.ref(rtdb, 'messages/current');
  readDocument = async () => (await sdk.getDoc(document)).data();
  readQuery = async () => (await sdk.getDocs(sdk.query(sdk.collection(db, 'messages')))).docs.map(doc => doc.data());
  readDatabase = async () => (await database.get(node)).val();
  listenDocument = next => sdk.onSnapshot(document, snap => next((snap as { data(): unknown }).data()));
  listenDatabase = next => database.onValue(node, snap => next(snap.val()));
  write = async () => { ++version; await sdk.setDoc(document, { version }); await database.set(node, { version }); };
  denied = () => sdk.getDoc(sdk.doc(db, 'private/denied'));
  deniedWrite = () => sdk.setDoc(document, { version: -1 });
  subscribeEvents = listener => { listener(sandbox.history()); return sandbox.onEvent(event => listener([event])); };
}
await write();
let mode!: ListenerMode;
mountPyricRuntimeChip({
  runtime: createPyricRuntimeStatus({ studioUrl: '', worker: { url: '/sdk-worker.js', name: 'sdk-flow', servedEpoch: 'example' } }),
  document, initiallyOpen: true, studioUrl: null, sandboxEvents: subscribeEvents,
  listeners: onChange => (mode = createListenerMode({ document, commits, subscribeEvents, onChange })),
});
mode.setMode('flow');
mode.setEnabled(true);

function DataPanel() {
  const [result, setResult] = React.useState('Select a read or start listeners.');
  const [listening, setListening] = React.useState(false);
  const readNumber = React.useRef(0);
  React.useEffect(() => {
    if (!listening) return;
    const one = listenDocument(data => setResult(`Firestore listener: ${JSON.stringify(data)}`));
    const two = listenDatabase(data => setResult(`Database listener: ${JSON.stringify(data)}`));
    return () => { one(); two(); };
  }, [listening]);
  const run = (label: string, read: () => Promise<unknown>) => async () => {
    const data = await read();
    setResult(`${label} #${++readNumber.current}: ${JSON.stringify(data)}`);
  };
  return h('section', { 'data-component': 'DataPanel' },
    h('h1', null, `Real SDK Flow / ${kind}`),
    h('div', { className: 'controls' },
      h('button', { 'data-read': 'document', onClick: run('Document read', readDocument) }, 'Read document'),
      h('button', { 'data-read': 'query', onClick: run('Query read', readQuery) }, 'Read collection'),
      h('button', { 'data-read': 'database', onClick: run('Database read', readDatabase) }, 'Read database'),
      h('button', { 'data-listen': '', onClick: () => setListening(!listening) }, listening ? 'Stop listeners' : 'Start listeners'),
      h('button', { 'data-write': '', onClick: write }, 'Write next version'),
      h('button', { 'data-unmapped': '', onClick: () => { void readDocument(); } }, 'Read without rendering'),
      h('button', { 'data-denied-write': '', onClick: () => { void deniedWrite().catch(() => {}); } }, 'Write denied update'),
      h('button', { 'data-denied': '', onClick: () => { void denied().catch(() => {}); } }, 'Read denied path'),
    ),
    h('article', { 'data-result': '' }, result),
  );
}
createRoot(document.querySelector('#app')!).render(h(React.Fragment, null, h(DataPanel), h(SecurityLab)));

function SecurityLab() {
  const [scenarioId, setScenarioId] = React.useState('ownership');
  const [result, setResult] = React.useState('Load the project to see its current data.');
  const [busy, setBusy] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const scenario = securityScenarios.find(item => item.id === scenarioId)!;
  const load = async () => {
    setBusy(true);
    try {
      const data = await readProject(scenario.path);
      setResult(JSON.stringify(data, null, 2));
      setLoaded(true);
    } finally { setBusy(false); }
  };
  const attempt = async () => {
    setBusy(true);
    try {
      await updateProject(scenario.path, scenario.proposed);
      setResult(`Saved successfully.\n${JSON.stringify(scenario.proposed, null, 2)}`);
    } catch {
      setResult('Change denied. The stored project is unchanged. Open this request in Traffic to inspect its deciding checks.');
    } finally { setBusy(false); }
  };
  return h('section', { 'data-component': 'SecurityLab', className: 'security-lab' },
    h('h2', null, 'Project security'),
    h('p', null, 'Requests run as Alice · role: member · team: north'),
    h('label', { htmlFor: 'security-scenario' }, 'Scenario'),
    h('select', { id: 'security-scenario', value: scenarioId, disabled: busy, onChange: (event: Event) => {
      setScenarioId((event.target as HTMLSelectElement).value); setLoaded(false); setResult('Load the project to see its current data.');
    } }, ...securityScenarios.map(item => h('option', { key: item.id, value: item.id }, item.label))),
    h('p', null, scenario.description),
    h('code', null, scenario.path),
    h('div', { className: 'controls' },
      h('button', { 'data-security-load': '', disabled: busy, onClick: load }, 'Load project'),
      h('button', { 'data-security-attempt': '', disabled: busy || !loaded, onClick: attempt }, 'Attempt change'),
    ),
    h('div', { className: 'security-proposed' }, h('strong', null, 'Proposed document'), h('pre', null, JSON.stringify(scenario.proposed, null, 2))),
    h('pre', { 'data-security-result': '', 'aria-live': 'polite' }, result),
  );
}
