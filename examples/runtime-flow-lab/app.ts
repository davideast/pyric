import { createWarningScenarios, warningBurstPlan } from './warning-scenarios.ts';
import type { AuthUserRecord } from "pyric/auth";
import type { AuthLens, SandboxEvent } from "pyric/sandbox";
import type { RuntimeIdentity } from "../../packages/cli/src/serve/runtime/identity.ts";
import { installReactCommitSource } from "../../packages/cli/src/serve/runtime/react-commit-source.ts";
import { mountPyricRuntimeChip } from "../../packages/cli/src/serve/runtime/chip.ts";
import { installChipFonts } from "../../packages/cli/src/serve/runtime/chip-fonts.ts";
import { createPyricRuntimeStatus } from "../../packages/cli/src/serve/runtime/status.ts";
import {
  createListenerMode,
  type ListenerMode,
} from "../../packages/cli/src/serve/runtime/listener-mode.ts";
import { captureFullState, initializeSandbox } from "pyric/sandbox";
import { setRules } from "pyric/sandbox/firestore";
import { createChatData, type ChatService, type ListenOptions } from "./chat-data.ts";
import * as database from "pyric/database";
import * as storage from "pyric/storage";
import { avatarAssetUrl } from "../../packages/cli/src/serve/assets/avatar-url.ts";
import { treatments, type TreatmentId } from "./treatments.ts";

const service: ChatService = new URLSearchParams(location.search).get("service") === "rtdb" ? "rtdb" : "firestore";
const sources = [
  {
    id: "messages",
    path: "conversations/design/messages",
    label: "New message",
  },
  { id: "presence", path: "/presence", label: "Presence" },
  { id: "typing", path: "/typing/design", label: "Typing" },
  {
    id: "receipts",
    path: "conversations/design/read-receipts/current",
    label: "Read receipt",
  },
];
function store<T>(initial: T) {
  let value = initial;
  const watchers = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (watch: () => void) => {
      watchers.add(watch);
      return () => {
        watchers.delete(watch);
      };
    },
    set: (next: T) => {
      value = next;
      for (const watch of watchers) watch();
    },
  };
}
const messageStore = store([
  {
    id: 1,
    who: "alice",
    name: "Alice Chen",
    text: "The presence indicator is ready. Can we check which components update?",
    time: "10:42",
  },
  {
    id: 2,
    who: "marcus",
    name: "Marcus Williams",
    text: "Yes. A new message should update the thread and the unread count.",
    time: "10:43",
  },
  {
    id: 3,
    who: "david",
    name: "David East",
    text: "Keep the channel header still. That makes the difference easier to see.",
    time: "10:44",
  },
]);
const presenceStore = store(true),
  typingStore = store(false),
  receiptStore = store(0);
const photo = (uid: string) =>
  avatarAssetUrl({
    uid,
    displayName: uid,
    email: null,
    providerId: "google.com",
  });
let mode: ListenerMode;
let sequence = 0;
let selectedSource = "messages";
let selectedTreatment: TreatmentId = "outline";

async function main() {
  installChipFonts(document);
  const commits = installReactCommitSource(window);
  // The renderer must load AFTER the commit hook, including its first import.
  const reactModule = await import("react");
  const React = reactModule.default ?? reactModule;
  const clientModule = await import("react-dom/client");
  const { createRoot } = clientModule.default ?? clientModule;
  const domModule = await import("react-dom");
  const { flushSync } = domModule.default ?? domModule;
  const h = React.createElement;
  const use = React.useSyncExternalStore;
  function Photo({ uid }: { uid: string }) {
    return h("img", {
      className: "photo",
      src: photo(uid),
      alt: "",
      referrerPolicy: "no-referrer",
    });
  }
  function UnreadBadge() {
    const messages = use(messageStore.subscribe, messageStore.get);
    return h(
      "span",
      { className: "unread-count", "data-component": "UnreadBadge" },
      String(messages.length - 2),
    );
  }
  function ChannelSidebar() {
    return h(
      "div",
      { className: "channel-list" },
      h(
        "div",
        { className: "channel active" },
        h("span", null, "# design"),
        h(UnreadBadge),
      ),
      h("div", { className: "channel" }, "# engineering"),
      h("div", { className: "channel" }, "# announcements"),
    );
  }
  function MemberList() {
    const online = use(presenceStore.subscribe, presenceStore.get);
    return h(
      "div",
      { className: "members", "data-component": "MemberList" },
      h(
        "div",
        { className: "member" },
        h(Photo, { uid: "alice" }),
        h(
          "span",
          { className: "member-copy" },
          "Alice",
          h("small", null, online ? "Online" : "Away"),
        ),
      ),
      h(
        "div",
        { className: "member" },
        h(Photo, { uid: "marcus" }),
        h(
          "span",
          { className: "member-copy" },
          "Marcus",
          h("small", null, "Online"),
        ),
      ),
    );
  }
  function PresenceStrip() {
    const online = use(presenceStore.subscribe, presenceStore.get);
    return h(
      "div",
      { className: "presence", "data-component": "PresenceStrip" },
      h("i", { className: `presence-dot${online ? "" : " away"}` }),
      online
        ? "Alice and Marcus are online"
        : "Marcus is online / Alice is away",
    );
  }
  function MessageBubble({
    message,
  }: {
    message: ReturnType<typeof messageStore.get>[number];
  }) {
    return h(
      "article",
      { className: "message", "data-component": "MessageBubble" },
      h(Photo, { uid: message.who }),
      h(
        "div",
        { className: "message-content" },
        h(
          "div",
          { className: "message-byline" },
          h("strong", null, message.name),
          h("time", null, message.time),
        ),
        h("p", { className: "message-body" }, message.text),
      ),
    );
  }
  const StableMessage = React.memo(MessageBubble);
  function MessageList() {
    const messages = use(messageStore.subscribe, messageStore.get);
    return h(
      "div",
      { className: "message-list", "data-component": "MessageList" },
      ...messages
        .slice(service === "rtdb" ? 0 : -4)
        .map((message) => h(StableMessage, { key: message.id, message })),
    );
  }
  function TypingIndicator() {
    const typing = use(typingStore.subscribe, typingStore.get);
    return h(
      "div",
      {
        className: `typing${typing ? "" : " typing-idle"}`,
        "data-component": "TypingIndicator",
      },
      typing
        ? h("span", { className: "typing-dots" }, h("i"), h("i"), h("i"))
        : null,
      typing ? "Alice is typing…" : "No one is typing",
    );
  }
  function ReadReceipt() {
    const receipt = use(receiptStore.subscribe, receiptStore.get);
    return h(
      "div",
      { className: "receipt", "data-component": "ReadReceipt" },
      receipt
        ? `Seen by Alice and Marcus / receipt ${receipt}`
        : "Last message delivered / not read yet",
    );
  }
  function ChatWorkspace() {
    return h(
      "section",
      {
        className: "chat",
        id: "chat-workspace",
        "aria-label": "Chat workspace",
      },
      h(
        "aside",
        { className: "channels inset" },
        h(
          "div",
          { className: "channel-title" },
          h("span", { className: "workspace-logo" }, "P"),
          "Product team",
        ),
        h(ChannelSidebar),
        h(MemberList),
      ),
      h(
        "div",
        { className: "conversation" },
        h(
          "header",
          { className: "conversation-header inset" },
          h(
            "div",
            { className: "channel-heading" },
            h("h2", null, "# design"),
            h("small", null, "3 members"),
          ),
          h(PresenceStrip),
        ),
        h("div", { className: "inset" }, h(MessageList)),
        h(
          "footer",
          { className: "message-footer inset" },
          h(TypingIndicator),
          h(ReadReceipt),
        ),
      ),
    );
  }
  flushSync(() =>
    createRoot(document.querySelector("#demo-app")!).render(h(ChatWorkspace)),
  );

  const users: Array<AuthUserRecord & { photoURL: string }> = [
    "david",
    "alice",
    "marcus",
    "avery",
    "test-0",
    "test-1",
    "test-2",
    "test-3",
    "test-4",
  ].map((uid, i) => ({
    uid,
    displayName:
      ["David East", "Alice Chen", "Marcus Williams", "Avery Jordan"][i] ??
      `Test user ${i - 3}`,
    email: `${uid}@example.com`,
    photoUrl: photo(uid),
    photoURL: photo(uid),
    providerUserInfo: [{ providerId: i % 2 ? "google.com" : "github.com" }],
    phoneNumber: null,
    customClaims: {},
    isAnonymous: false,
    disabled: false,
    emailVerified: true,
    tenantId: null,
    createdAt: "2026-09-12T00:00:00Z",
    lastLoginAt: null,
  }));
  let current: RuntimeIdentity | null = users[0] ?? null;
  let authChanged = (_user: RuntimeIdentity | null) => {};
  const sandbox = initializeSandbox();
  sandbox.currentUser = current ? { uid: current.uid } : null;
  setRules(sandbox, `rules_version = '2'; service cloud.firestore {
    match /databases/{database}/documents {
      match /scenario-denials/{id} { allow read: if true; allow write: if request.resource.data.budget >= 0; }
      match /conversations/design/{document=**} { allow read, write: if true; }
    }
  }`);
  const attachments = storage.getStorageSandbox(sandbox, { dbName: 'flow-lab-attachments', rules: `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /attachments/{file} { allow read, write: if true; } } }` });
  const attachment = storage.ref(attachments, 'attachments/design.bin');
  const payload = new Uint8Array(16 * 1024);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-storage]')) {
    button.onclick = async () => {
      const status = document.querySelector('#storage-status')!;
      button.disabled = true;
      try {
        const action = button.dataset.storage;
        if (action === 'download') {
          const bytes = await storage.getBytes(attachment);
          status.textContent = `Downloaded ${bytes.byteLength / 1024} KiB.`;
        } else if (action === 'delete') {
          await storage.deleteObject(attachment); status.textContent = 'Attachment deleted.';
        } else if (action === 'denied') {
          await storage.uploadBytes(storage.ref(attachments, 'private/denied.bin'), payload);
        } else if (action === 'burst') {
          for (let i = 0; i < 80; i++) {
            await storage.uploadBytes(attachment, payload);
            status.textContent = `Storage burst: ${i + 1} of 80 uploads.`;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } else {
          await storage.uploadBytesResumable(attachment, payload);
          status.textContent = 'Uploaded 16 KiB. Open Traffic → Rates → Storage to inspect.';
        }
      } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
      finally { button.disabled = false; }
    };
  }
  const rtdb = database.getDatabase(sandbox);
  database.sandbox.setRules(rtdb, { rules: {
    presence: { '.read': true, '.write': true },
    typing: { '.read': true, '.write': true },
  } });
  database.sandbox.setData(rtdb, { presence: { online: true }, typing: { design: false } });
  const chat = createChatData(sandbox, service, messageStore.get());
  await chat.rules();
  const subscribeEvents = (listener: (events: readonly SandboxEvent[]) => void) => {
    listener(sandbox.history());
    return sandbox.onEvent(event => listener([event]));
  };
  let lens: AuthLens | undefined;
  const runtime = createPyricRuntimeStatus({
    studioUrl: "/__pyric/ui/studio",
    worker: { url: "/worker.js", name: "flow-lab", servedEpoch: "preview" },
  });
  const chip = mountPyricRuntimeChip({
    runtime,
    initiallyOpen: innerWidth >= 1250,
    identity: {
      getCurrentUser: () => current,
      listUsers: () => users,
      subscribeAuth: (fn) => {
        authChanged = fn;
        return () => {};
      },
      switchUser: (uid) => {
        current = users.find((user) => user.uid === uid) ?? null;
        sandbox.currentUser = current ? { uid: current.uid } : null;
        authChanged(current);
      },
      signOut: () => {
        current = null;
        sandbox.currentUser = null;
        authChanged(null);
      },
    },
    getLens: () => lens,
    setLens: (next) => {
      lens = next;
    },
    subscribeLens: () => () => {},
    captureSession: async () => ({ format: 'pyric.full-state', state: await captureFullState(sandbox), events: sandbox.history() }),
    sandboxEvents: subscribeEvents,
    listeners: (onChange) =>
      (mode = createListenerMode({
        document,
        onChange: (outlines) => {
          onChange(outlines);
          const state = mode?.treatmentState?.();
          if (state && !state.loading) syncStudy(state.selected);
        },
        commits,
        themeStorage: null,
        paintStorage: null,
        incidents: () => [],
        subscribeEvents,
        overlayTheme: {
          "--pyric-overlay-badge-font-family": '"Pyric Geist Mono",monospace',
        },
      })),
  });
  mode.setMode("flow");
  mode.setEnabled(true);

  function received(id: string, update: () => void) {
    flushSync(update);
    const source = sources.find(source => source.id === id)!;
    document.querySelector("#delivery-status")!.textContent =
      `Delivery ${++sequence} / ${id === 'messages' ? chat.messagePath() : service === 'rtdb' && id === 'receipts' ? '/conversations/design/receipts' : source.path} / observed after a React commit`;
  }
  const owner = { kind: 'component' as const, name: 'ChatWorkspace', element: document.querySelector('#chat-workspace')! };
  chat.connect(owner, messages => {
    received('messages', () => {
      const previous = new Map(messageStore.get().map(message => [message.id, message]));
      messageStore.set(messages.map(message => {
        const prior = previous.get(message.id);
        return prior && JSON.stringify(prior) === JSON.stringify(message) ? prior : message;
      }));
    });
  }, count => received('receipts', () => receiptStore.set(count)));
  let subscriptions: (() => void)[] = [];
  function stopCommon() { subscriptions.forEach(stop => stop()); subscriptions = []; }
  function startCommon() {
    stopCommon();
    subscriptions = [
    database.onValue(database.ref(rtdb, '/presence'), snapshot => {
      received('presence', () => presenceStore.set(snapshot.child('online').val() === true));
    }, { owner }),
    database.onValue(database.ref(rtdb, '/typing/design'), snapshot => {
      received('typing', () => typingStore.set(snapshot.val() === true));
    }, { owner }),
    ];
  }
  startCommon();
  window.addEventListener('pagehide', () => { chat.stop(); for (const stop of subscriptions) stop(); }, { once: true });

  const examples = [
    "The unread badge should move with this message.",
    "This update belongs to the conversation only.",
    "The team list should stay still for a message delivery.",
    "Try Presence next: two separate regions should respond.",
    "A burst makes repeated updates easier to compare.",
  ];
  let nextMessageId = chat.initialCount;
  async function deliver(id: string) {
    selectedSource = id;
    if (id === 'messages') {
      const messageId = ++nextMessageId;
      await chat.write({
        id: messageId,
        who: 'alice',
        name: 'Alice Chen',
        text: examples[(messageId - 4) % examples.length]!,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
    } else if (id === 'presence') {
      await database.update(database.ref(rtdb, '/presence'), { online: !presenceStore.get() });
    } else if (id === 'typing') {
      await database.set(database.ref(rtdb, '/typing/design'), !typingStore.get());
    } else if (id === 'receipts') {
      await chat.markRead(receiptStore.get() + 1);
    }
  }
  function reportError(error: unknown) {
    document.querySelector('#delivery-status')!.textContent =
      error instanceof Error ? error.message : 'The chat update failed.';
    console.error(error);
  }
  async function refreshData() {
    const [messages, presence] = await Promise.all([
      chat.read(),
      database.get(database.ref(rtdb, '/presence')),
    ]);
    document.querySelector('#delivery-status')!.textContent =
      `Read ${messages} messages. Alice and Marcus are ${presence.child('online').val() === true ? 'online' : 'offline'}.`;
  }
  document.querySelector<HTMLButtonElement>('#refresh')!.onclick = () => {
    void refreshData().catch(reportError);
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-deliver]')) {
    button.onclick = () => { void deliver(button.dataset.deliver!).catch(reportError); };
  }
  let bursting = false;
  async function runBurst(rateTest = false) {
    if (bursting) return;
    bursting = true;
    document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".data-controls button, .data-controls select, .delivery-buttons button, .scenario-buttons button").forEach(control => { control.disabled = true; });
    try {
      await refreshData();
      const plan = rateTest ? await warningBurstPlan(service) : null;
      const updates = plan ? Array.from({ length: plan.count }, () => 'messages') : ['messages', 'presence', 'typing', 'messages', 'receipts'];
      for (const id of updates) {
        await deliver(id);
        await new Promise(resolve => setTimeout(resolve, plan?.delay ?? 650));
      }
    } catch (error) {
      reportError(error);
    } finally {
      document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".data-controls button, .data-controls select, .delivery-buttons button, .scenario-buttons button").forEach(control => { control.disabled = false; });
      syncDataControls();
      bursting = false;
    }
  }
  document.querySelector<HTMLButtonElement>("#burst")!.onclick = () => { void runBurst(); };
  document.querySelector<HTMLButtonElement>("#rate-burst")!.onclick = () => { void runBurst(true); };
  const scenarios = createWarningScenarios(sandbox);
  const scenarioStatus = document.querySelector<HTMLElement>('#scenario-status')!;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-scenario]')) {
    button.onclick = async () => {
      const name = button.dataset.scenario;
      button.disabled = true;
      try {
        if (name === 'firestore-index') {
          await scenarios.firestoreIndex();
          scenarioStatus.textContent = 'Firestore index missing. Open the query in Traffic to add it.';
        } else {
          const action = name === 'firestore-denial' ? scenarios.firestoreDenial : name === 'rtdb-denial' ? scenarios.rtdbDenial : scenarios.rtdbIndex;
          await action();
          scenarioStatus.textContent = 'The request succeeded unexpectedly.';
        }
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (name === 'rtdb-index' && error instanceof Error && error.message.includes('.indexOn')) scenarioStatus.textContent = 'RTDB .indexOn missing. Open the query in Traffic to add it.';
        else if (code === 'permission-denied' || code === 'PERMISSION_DENIED') scenarioStatus.textContent = `${name === 'firestore-denial' ? 'Firestore' : 'RTDB'} write denied. The budget must be zero or greater.`;
        else scenarioStatus.textContent = error instanceof Error ? error.message : 'Unable to run this scenario.';
      } finally { button.disabled = false; }
    };
  }
  const backend = document.querySelector<HTMLSelectElement>('#chat-service')!;
  backend.value = service;
  backend.onchange = () => { const url = new URL(location.href); url.searchParams.set('service', backend.value); location.href = url.href; };
  document.querySelector<HTMLElement>('#rtdb-controls')!.hidden = service !== 'rtdb';
  let listening = true;
  const listenerMode = document.querySelector<HTMLSelectElement>('#listener-mode')!;
  const listenerScope = document.querySelector<HTMLSelectElement>('#listener-scope')!;
  const listenerButton = document.querySelector<HTMLButtonElement>('#listeners')!;
  function syncDataControls() {
    listenerScope.disabled = listenerMode.value === 'children';
    document.querySelector<HTMLButtonElement>('#older')!.disabled = listenerScope.value === 'conversation';
    listenerButton.textContent = listening ? 'Stop listeners' : 'Start listeners';
  }
  function configureListeners() {
    if (listenerMode.value === 'children') listenerScope.value = 'messages';
    if (listening) chat.start({ mode: listenerMode.value, scope: listenerScope.value } as ListenOptions);
    syncDataControls();
  }
  listenerMode.onchange = configureListeners;
  listenerScope.onchange = configureListeners;
  listenerButton.onclick = () => { listening = !listening; if (listening) { configureListeners(); startCommon(); } else { chat.stop(); stopCommon(); } syncDataControls(); };
  document.querySelector<HTMLButtonElement>('#older')!.onclick = () => {
    void chat.loadOlder().then(count => { document.querySelector('#delivery-status')!.textContent = `Loaded ${count} older messages.`; }).catch(reportError);
  };
  document.querySelector<HTMLButtonElement>('#edit-message')!.onclick = () => {
    const message = messageStore.get().at(-1);
    if (message) void chat.write({ ...message, text: `${message.text} Edited.` }).catch(reportError);
  };
  document.querySelector<HTMLButtonElement>('#query-index')!.onclick = () => {
    void chat.queryIndex().then(count => { document.querySelector('#delivery-status')!.textContent = `Found ${count} messages by Alice.`; }).catch(error => {
      if (error instanceof Error && error.message.includes('.indexOn')) document.querySelector('#delivery-status')!.textContent = 'Missing index. Open this query in Traffic.';
      else reportError(error);
    });
  };
  document.querySelector<HTMLButtonElement>('#reset-data')!.onclick = () => {
    stopCommon(); chat.reset(); startCommon(); nextMessageId = chat.initialCount; listening = true; syncDataControls();
  };
  document.querySelector<HTMLButtonElement>('#reset-index')!.onclick = () => {
    void (async () => {
      const init = await (await fetch('/__pyric/init.json')).json();
      const response = await fetch('/__demo/reset-index', { method: 'POST', headers: { 'x-pyric-session-token': init.sessionToken } });
      if (!response.ok) throw new Error('Unable to reset the demo index.');
      await chat.rules();
      document.querySelector('#delivery-status')!.textContent = 'Demo index reset. Run Find Alice messages again.';
    })().catch(reportError);
  };
  syncDataControls();
  document.querySelector<HTMLButtonElement>("#clear")!.onclick = () => {
    for (const source of mode.outlines()) {
      mode.setListenerVisible(source.listenerId, false);
      mode.setListenerVisible(source.listenerId, true);
    }
    mode.clearTreatmentHistory?.();
    document.querySelector("#delivery-status")!.textContent =
      "Marks and history cleared. Chat data is unchanged.";
  };
  document.querySelector<HTMLButtonElement>("#inspector")!.onclick = () => {
    const root = chip.element.shadowRoot!;
    const expand = root.querySelector<HTMLButtonElement>("[data-expand]");
    if (expand) {
      expand.click();
      root
        .querySelector<HTMLButtonElement>('[data-chip-tab="listeners"]')
        ?.click();
    } else root.querySelector<HTMLButtonElement>("[data-collapse]")?.click();
  };
  chip.element.shadowRoot
    ?.querySelector<HTMLButtonElement>('[data-chip-tab="listeners"]')
    ?.click();
  const select = document.querySelector<HTMLSelectElement>("#treatment")!;
  const index = document.querySelector("#treatment-index")!;
  for (const group of ["Standard", "Experimental"]) {
    const options = document.createElement("optgroup");
    options.label = group;
    select.append(options);
    const section = document.createElement("div");
    section.className = "index-group";
    const heading = document.createElement("h3");
    heading.textContent = group;
    section.append(heading);
    index.append(section);
    for (const treatment of treatments.filter((item) => item.group === group)) {
      const option = document.createElement("option");
      option.value = treatment.id;
      option.textContent = treatment.name;
      options.append(option);
      const button = document.createElement("button");
      button.className = "index-choice";
      button.dataset.treatment = treatment.id;
      const inner = document.createElement("span"),
        name = document.createElement("strong"),
        description = document.createElement("small");
      name.textContent = treatment.name;
      description.textContent = treatment.description;
      inner.append(name, description);
      button.append(inner);
      section.append(button);
      button.onclick = () => {
        choose(treatment.id);
        document
          .querySelector(".study")!
          .scrollIntoView({ block: "start", behavior: "instant" });
      };
    }
  }
  function syncStudy(id: string) {
    const treatment = treatments.find((item) => item.id === id);
    if (!treatment) return;
    selectedTreatment = treatment.id;
    const picker = document.querySelector<HTMLSelectElement>("#treatment")!;
    picker.value = id;
    document.querySelector("#color-legend")!.textContent =
      id === "heat"
        ? "Heat color = observed update count"
        : "Listener color stays consistent across treatments.";
    document.querySelector("#treatment-description")!.textContent =
      treatment.description;
    document.querySelector("#treatment-use")!.textContent =
      `${treatment.useful} ${treatment.limit}`;
    for (const button of document.querySelectorAll<HTMLElement>(
      "[data-treatment]",
    ))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.treatment === id),
      );
  }
  async function choose(id: TreatmentId, preview = true) {
    await mode.setTreatment?.(id);
    syncStudy(id);
    if (preview) {
      mode.setMode("flow");
      mode.setEnabled(true);
      for (const source of mode.outlines()) mode.setListenerVisible(source.listenerId, true);
      await deliver(selectedSource);
    }
  }
  select.onchange = () => choose(select.value as TreatmentId);
  for (const [id, direction] of [
    ["previous", -1],
    ["next", 1],
  ] as const)
    document.querySelector<HTMLButtonElement>(`#${id}`)!.onclick = () =>
      choose(
        treatments[
          (treatments.findIndex((item) => item.id === selectedTreatment) +
            direction +
            treatments.length) %
            treatments.length
        ]!.id,
      );
  // The runtime restores the project default or saved selection.
  // Rendering, metadata, and geometry now belong to the shared runtime registry.
}
void main().catch(error => { console.error(error); document.querySelector("#delivery-status")!.textContent = String(error); });
