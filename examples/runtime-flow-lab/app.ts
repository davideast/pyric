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
import { reportListenerDelivery } from "../../packages/cli/src/serve/worker/client/listener-delivery.ts";
import { avatarAssetUrl } from "../../packages/cli/src/serve/assets/avatar-url.ts";
import { treatments, type TreatmentId } from "./treatments.ts";

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
    path: "conversations/design/read-receipts",
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
let sourceElement: HTMLElement | null = null;
let lastMarked: HTMLElement[] = [];
const hits = new Map<HTMLElement, { count: number; sequence: number }>();
const flowHistory: Array<{
  sequence: number;
  elements: HTMLElement[];
  color: string;
}> = [];
let svg: SVGSVGElement | null = null;

async function main() {
  installChipFonts(document);
  const commits = installReactCommitSource(window);
  // The renderer must load AFTER the commit hook, including its first import.
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
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
        .slice(-4)
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
  let eventChanged = (_events: readonly SandboxEvent[]) => {};
  let trafficChanged = (_events: readonly SandboxEvent[]) => {};
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
        authChanged(current);
      },
      signOut: () => {
        current = null;
        authChanged(null);
      },
    },
    getLens: () => lens,
    setLens: (next) => {
      lens = next;
    },
    subscribeLens: () => () => {},
    sandboxEvents: (fn) => {
      trafficChanged = fn;
      return () => {};
    },
    listeners: (onChange) =>
      (mode = createListenerMode({
        document,
        onChange,
        commits,
        themeStorage: null,
        paintStorage: null,
        incidents: () => [],
        subscribeEvents: (fn) => {
          eventChanged = fn;
          return () => {};
        },
        overlayTheme: {
          "--pyric-overlay-badge-font-family": '"Pyric Geist Mono",monospace',
        },
      })),
  });
  eventChanged(
    sources.map((source) => ({
      kind: "listener_attach",
      id: `attach-${source.id}`,
      at: Date.now(),
      listenerId: source.id,
      target: { kind: "doc", path: source.path },
      auth: null,
      owners: [
        {
          kind: "component",
          name: "ChatWorkspace",
          element: "#chat-workspace",
        },
      ],
    })),
  );
  mode.setMode("flow");
  mode.setEnabled(true);

  const examples = [
    "The unread badge should move with this message.",
    "This update belongs to the conversation only.",
    "The team list should stay still for a message delivery.",
    "Try Presence next: two separate regions should respond.",
    "A burst makes repeated updates easier to compare.",
  ];
  function deliver(id: string, button?: HTMLElement) {
    const source = sources.find((source) => source.id === id)!;
    selectedSource = id;
    sourceElement = button ?? document.querySelector(`[data-deliver="${id}"]`);
    sequence++;
    eventChanged([
      {
        kind: "snapshot_delivery",
        id: `delivery-${sequence}`,
        at: Date.now(),
        listenerId: id,
        target: { kind: "doc", path: source.path },
        auth: null,
        addedCount: 0,
        modifiedCount: 1,
        removedCount: 0,
        size: 1,
      },
    ]);
    // Same ordering as the worker read adapters: delivery, callback, commit.
    reportListenerDelivery(id);
    flushSync(() => {
      if (id === "messages") {
        const all = messageStore.get();
        messageStore.set([
          ...all,
          {
            id: all.length + 1,
            who: "alice",
            name: "Alice Chen",
            text: examples[(all.length - 3) % examples.length]!,
            time: new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
          },
        ]);
      }
      if (id === "presence") presenceStore.set(!presenceStore.get());
      if (id === "typing") typingStore.set(!typingStore.get());
      if (id === "receipts") receiptStore.set(receiptStore.get() + 1);
    });
    trafficChanged([
      {
        kind: "request",
        id: `request-${sequence}`,
        at: Date.now(),
        evalMs: 0,
        origin: "listener",
        reasons: ["Simulated preview delivery"],
        method: "get",
        path: source.path,
        result: "allow",
        auth: null,
      },
    ]);
    document.querySelector("#delivery-status")!.textContent =
      `Delivery ${sequence} / ${source.path} / observed after a React commit`;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-deliver]",
  ))
    button.onclick = () => deliver(button.dataset.deliver!, button);
  let bursting = false;
  document.querySelector<HTMLButtonElement>("#burst")!.onclick = async () => {
    if (bursting) return;
    bursting = true;
    const button = document.querySelector<HTMLButtonElement>("#burst")!;
    button.disabled = true;
    for (const id of [
      "messages",
      "presence",
      "typing",
      "messages",
      "receipts",
    ]) {
      deliver(id);
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    button.disabled = false;
    bursting = false;
  };
  document.querySelector<HTMLButtonElement>("#clear")!.onclick = () => {
    for (const source of sources) {
      mode.setListenerVisible(source.id, false);
      mode.setListenerVisible(source.id, true);
    }
    hits.clear();
    flowHistory.length = 0;
    lastMarked = [];
    svg?.replaceChildren();
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
  function choose(id: TreatmentId, preview = true) {
    selectedTreatment = id;
    document.documentElement.dataset.flowTreatment = id;
    select.value = id;
    const treatment = treatments.find((item) => item.id === id)!;
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
    svg?.replaceChildren();
    if (preview) {
      mode.setMode("flow");
      mode.setEnabled(true);
      for (const source of sources) mode.setListenerVisible(source.id, true);
      deliver(selectedSource);
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
  choose("outline", false);
  observeMarks();
  window.addEventListener("resize", drawMap);
  window.addEventListener("scroll", drawMap, { capture: true, passive: true });
  // Keep the initial state quiet; a user action supplies the first real render.
}

function observeMarks() {
  const observer = new MutationObserver((records) => {
    const marked = new Set<HTMLElement>();
    for (const record of records) {
      if (
        record.type !== "attributes" ||
        record.attributeName !== "data-pyric-flow-label"
      )
        continue;
      const element = record.target as HTMLElement;
      if (element.hasAttribute("data-pyric-flow") && element.isConnected)
        marked.add(element);
    }
    if (!marked.size) return;
    const fresh = [...marked].filter(
      (element) => hits.get(element)?.sequence !== sequence,
    );
    if (!fresh.length) return;
    for (const element of fresh) {
      const count = (hits.get(element)?.count ?? 0) + 1;
      hits.set(element, { count, sequence });
      const rect = element.getBoundingClientRect();
      element.dataset.labHits = String(count);
      element.dataset.labSequence = String(sequence);
      element.dataset.labName =
        element.dataset.component ?? element.tagName.toLowerCase();
      element.dataset.labSize = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
      element.style.setProperty(
        "--lab-heat",
        String(Math.max(32, 210 - count * 22)),
      );
      // Restart the study's one-shot visual without moving application content.
      for (const animation of element.getAnimations({ subtree: true })) {
        if (
          animation instanceof CSSAnimation &&
          animation.animationName.startsWith("lab-")
        ) {
          animation.cancel();
          animation.play();
        }
      }
    }
    lastMarked = fresh;
    flowHistory.push({
      sequence,
      elements: fresh,
      color:
        getComputedStyle(fresh[0]!)
          .getPropertyValue("--pyric-overlay-hue")
          .trim() || "#91baff",
    });
    if (flowHistory.length > 5) flowHistory.shift();
    drawMap();
  });
  observer.observe(document.querySelector("#chat-workspace")!, {
    subtree: true,
    attributes: true,
    attributeFilter: ["data-pyric-flow-label"],
  });
}
function svgElement(name: string, attrs: Record<string, string | number>) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, String(value));
  return node;
}
function drawMap() {
  const overlay = document.querySelector("[data-pyric-listener-overlay]");
  if (!overlay) return;
  if (!svg || !svg.isConnected) {
    svg = svgElement("svg", {
      class: "lab-flow-map",
      "aria-hidden": "true",
    }) as SVGSVGElement;
    overlay.append(svg);
  }
  svg.replaceChildren();
  if (!["threads", "trail", "minimap"].includes(selectedTreatment)) return;
  const color = flowHistory.at(-1)?.color ?? "#91baff";
  const active = lastMarked.filter(
    (element) => element.isConnected && element.hasAttribute("data-pyric-flow"),
  );
  if (selectedTreatment === "threads" && sourceElement) {
    const from = sourceElement.getBoundingClientRect(),
      x = from.left + from.width / 2,
      y = from.bottom + 5;
    for (const element of active) {
      const to = element.getBoundingClientRect();
      svg.append(
        svgElement("path", {
          d: `M ${x} ${y} C ${x} ${y + 30}, ${to.left - 16} ${to.top - 30}, ${to.left} ${to.top}`,
          fill: "none",
          stroke: color,
          "stroke-width": 1.5,
          opacity: 0.75,
        }),
        svgElement("circle", { cx: to.left, cy: to.top, r: 3, fill: color }),
      );
    }
  }
  if (selectedTreatment === "trail") {
    const points = flowHistory
      .map((entry) => {
        const element = entry.elements.find((el) => el.isConnected);
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { x: r.right - 8, y: r.top + 8, entry };
      })
      .filter((point) => point !== null);
    if (points.length)
      svg.append(
        svgElement("polyline", {
          points: points.map((point) => `${point.x},${point.y}`).join(" "),
          fill: "none",
          stroke: color,
          "stroke-width": 1,
          "stroke-dasharray": "3 5",
          opacity: 0.65,
        }),
      );
    points.forEach((point, i) => {
      const offset = i * 3;
      svg!.append(
        svgElement("circle", {
          cx: point.x + offset,
          cy: point.y + offset,
          r: 11,
          fill: "#151d2a",
          stroke: point.entry.color,
        }),
      );
      const text = svgElement("text", {
        x: point.x + offset,
        y: point.y + offset + 3,
        "text-anchor": "middle",
      });
      text.textContent = String(point.entry.sequence);
      svg!.append(text);
    });
  }
  if (selectedTreatment === "minimap") {
    const chat = document
      .querySelector("#chat-workspace")!
      .getBoundingClientRect();
    const width = Math.min(160, chat.width * 0.4),
      scale = width / chat.width,
      height = chat.height * scale;
    const x = Math.max(8, chat.right - width - 8),
      y = Math.max(8, chat.top + 8);
    svg.append(
      svgElement("rect", {
        x: x - 5,
        y: y - 20,
        width: width + 10,
        height: height + 25,
        rx: 5,
        fill: "#101723",
        stroke: "#5f718a",
      }),
    );
    const label = svgElement("text", { x, y: y - 7 });
    label.textContent = "OBSERVED REGIONS";
    svg.append(label);
    for (const el of document.querySelectorAll<HTMLElement>(
      "#chat-workspace [data-component]",
    )) {
      const rect = el.getBoundingClientRect(),
        isActive = active.includes(el);
      svg.append(
        svgElement("rect", {
          x: x + (rect.left - chat.left) * scale,
          y: y + (rect.top - chat.top) * scale,
          width: Math.max(2, rect.width * scale),
          height: Math.max(2, rect.height * scale),
          fill: isActive ? color : "#222e40",
          stroke: "#7385a1",
          "stroke-width": 0.4,
          opacity: isActive ? 0.85 : 0.65,
        }),
      );
    }
  }
}
void main();
