import { useEffect, useMemo, useRef, useState } from 'react';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import { createElement, isValidElement, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Bell, Check, CheckCircle2, ChevronsUpDown, Code2, Copy, LoaderCircle, LogIn, LogOut, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Square, TerminalSquare, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup, MessageHeader } from '@/components/ui/message';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller, useMessageScrollerScrollable } from '@/components/ui/message-scroller';
import type { ChatPageServices, UiConversation, UiMessage, UiNotification, UiPresence, UiToolCall, UiUsage, UiUser } from './chat-types';
import type { ChatMode } from '../../chat-mode';
import { MarkdownMessage } from './markdown-message';
import { storePreviewComponent } from './preview-component-state';
import { reconcileMessages, starterMessages } from './message-reconciliation';

const initials = (user: UiUser | null): string =>
  (user?.displayName ?? user?.email ?? 'You').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();

const formatTime = (date?: Date): string => date ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date) : '';
const errorMessage = (reason: unknown, fallback: string): string => reason instanceof Error ? reason.message : fallback;
const isAbort = (reason: unknown): boolean => reason instanceof DOMException && reason.name === 'AbortError';
const modeOptions: Array<{ id: ChatMode; label: string; description: string; placeholder: string }> = [
  { id: 'explore', label: 'Explore', description: 'Open possibilities', placeholder: 'Explore an idea…' },
  { id: 'plan', label: 'Plan', description: 'Make it actionable', placeholder: 'Turn an idea into a plan…' },
  { id: 'refine', label: 'Refine', description: 'Pressure-test a direction', placeholder: 'Pressure-test a direction…' },
];
const conversationIdFromUrl = (): string | null => new URLSearchParams(window.location.search).get('conversation');

const writeConversationUrl = (conversationId: string | null, replace = false): void => {
  const url = new URL(window.location.href);
  if (conversationId) url.searchParams.set('conversation', conversationId);
  else url.searchParams.delete('conversation');
  window.history[replace ? 'replaceState' : 'pushState']({}, '', `${url.pathname}${url.search}${url.hash}`);
};

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button variant="ghost" size="icon-xs" aria-label={copied ? 'Message copied' : 'Copy message'} title={copied ? 'Message copied' : 'Copy message'} onClick={() => void copy()} disabled={!text}>
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

function StartPlanCard({ onStart, onDecline, onSendDirection }: { onStart: () => void; onDecline: () => void; onSendDirection: (direction: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [direction, setDirection] = useState('');

  const sendDirection = () => {
    const value = direction.trim();
    if (!value) return;
    onSendDirection(value);
  };

  return (
    <section aria-label="Start plan" className="mt-2 max-w-full rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Ready to start the plan?</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">PyChat can turn this direction into the first actionable step.</p>
        </div>
        <span className="shrink-0 rounded-md bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">Plan</span>
      </div>
      {editing && <textarea value={direction} onChange={(event) => setDirection(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') sendDirection(); }} autoFocus rows={2} placeholder="Tell PyChat what to change…" aria-label="What should PyChat change?" className="mt-3 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onStart}>Start plan</Button>
        {editing ? <Button size="sm" variant="secondary" onClick={sendDirection} disabled={!direction.trim()}>Send direction</Button> : <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Tell PyChat what to change</Button>}
        <Button size="sm" variant="ghost" onClick={onDecline}>Decline</Button>
      </div>
    </section>
  );
}

function ToolActivity({ calls }: { calls: UiToolCall[] }) {
  if (!calls.length) return null;
  return (
    <Collapsible className="mb-1 min-w-0 w-full max-w-full rounded-lg border bg-background/40 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground"><TerminalSquare className="size-3.5 shrink-0" /> Workspace activity <span className="font-normal">· {calls.length}</span></span>
        <CollapsibleTrigger render={<Button variant="ghost" size="icon" className="size-7" />} aria-label="Toggle workspace activity"><ChevronsUpDown /></CollapsibleTrigger>
      </div>
      <CollapsibleContent className="space-y-1.5 pt-2">
        {calls.map((call) => <div key={call.id} className="flex min-w-0 items-center gap-2 text-xs"><span className="shrink-0 text-muted-foreground">{call.status === 'running' ? <LoaderCircle className="size-3.5 animate-spin" /> : call.status === 'complete' ? <CheckCircle2 className="size-3.5 text-primary" /> : <XCircle className="size-3.5 text-destructive" />}</span><span className="truncate font-mono">{call.name}</span><span className="truncate text-muted-foreground">{call.summary ?? (call.status === 'running' ? 'Running…' : '')}</span></div>)}
      </CollapsibleContent>
    </Collapsible>
  );
}

function UsageSummary({ usage }: { usage?: UiUsage }) {
  if (!usage) return null;
  const total = usage.inputTokens + usage.outputTokens;
  return <span className="inline-flex items-center gap-1.5"><span>{total.toLocaleString()} tokens</span>{usage.reasoningTokens ? <span>· {usage.reasoningTokens.toLocaleString()} thinking</span> : null}</span>;
}

function ThoughtsDisclosure({ thoughts, streaming }: { thoughts: string; streaming: boolean }) {
  return (
    <Collapsible defaultOpen={streaming} className="mb-1 min-w-0 w-full max-w-full rounded-lg border border-dashed bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">Thoughts</span>
        <CollapsibleTrigger render={<Button variant="ghost" size="icon" className="size-7" />} aria-label="Toggle thoughts">
          <ChevronsUpDown />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="pt-2">
        <MarkdownMessage content={thoughts} className="max-w-full text-xs leading-5 text-muted-foreground" />
      </CollapsibleContent>
    </Collapsible>
  );
}

function StreamingFollow({ revision, streaming }: { revision: string; streaming: boolean }) {
  const { end } = useMessageScrollerScrollable();
  const { scrollToEnd } = useMessageScroller();
  const followingRef = useRef(true);

  useEffect(() => {
    if (!streaming) {
      followingRef.current = true;
      return;
    }
    if (!end) followingRef.current = false;
  }, [end, streaming]);

  useEffect(() => {
    if (!streaming || !followingRef.current) return;
    const frame = window.requestAnimationFrame(() => scrollToEnd());
    return () => window.cancelAnimationFrame(frame);
  }, [revision, scrollToEnd, streaming]);

  return null;
}

class PreviewErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : 'The preview component threw while rendering.' };
  }
  render() {
    return this.state.error
      ? <div className="p-4 text-xs text-destructive">Runtime error: {this.state.error}</div>
      : this.props.children;
  }
}

// Turn the module's default export into something renderable, INSIDE the error
// boundary: a function component is instantiated, an already-built element is
// rendered as-is, and anything else throws so the boundary shows the reason
// instead of the whole page crashing. Doing the createElement here (not in the
// parent's render) keeps a bad export from escaping the boundary.
function PreviewHost({ node }: { node: unknown }): React.ReactNode {
  if (isValidElement(node)) return node;
  if (typeof node === 'function') return createElement(node as ComponentType);
  throw new Error('The default export is not a React component. Export default a function that returns JSX.');
}

function WorkspacePreview({ services, revision, onClose }: { services: ChatPageServices; revision: number; onClose: () => void }) {
  const [source, setSource] = useState('');
  const [component, setComponent] = useState<unknown>(null);
  const [diagnostics, setDiagnostics] = useState<Array<{ message: string; line?: number; column?: number }>>([]);
  const [frameBody, setFrameBody] = useState<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // The preview renders through a portal into this iframe's document body: the
  // component stays in the parent React tree (StrictMode and lifecycle handled
  // by the app's root — the cross-realm createRoot mount silently failed), but
  // its DOM lives in a separate document, isolated from the app. Mirror the
  // host stylesheets in so framework CSS (Tailwind) still applies.
  const handleFrameLoad = () => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    doc.head.querySelectorAll('[data-preview-style]').forEach((node) => node.remove());
    document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
      const clone = node.cloneNode(true) as HTMLElement;
      clone.setAttribute('data-preview-style', '');
      doc.head.appendChild(clone);
    });
    setFrameBody(doc.body);
  };

  useEffect(() => {
    let alive = true;
    void services.workspace.readAppSource().then((nextSource) => { if (alive) setSource(nextSource); }).catch((reason: unknown) => { if (alive) setDiagnostics([{ message: reason instanceof Error ? reason.message : 'Could not read the workspace app' }]); });
    return () => { alive = false; };
  }, [revision, services]);

  useEffect(() => {
    let alive = true;
    if (!source) return;
    void services.workspace.previewApp(source, { react: React as unknown as Record<string, unknown>, jsxRuntime: jsxRuntime as unknown as Record<string, unknown>, jsxDevRuntime: jsxDevRuntime as unknown as Record<string, unknown> }).then((result) => {
      if (!alive) return;
      const exported = result.ok ? result.component : null;
      if (result.ok && (typeof exported === 'function' || isValidElement(exported))) { storePreviewComponent(setComponent, exported); setDiagnostics([]); }
      else { setComponent(null); setDiagnostics([{ message: 'Preview compiled, but the default export is not a React component. Export default a function that returns JSX (e.g. export default function App() { return <h1>Hi</h1>; }).' }]); }
    }).catch((reason: unknown) => { if (alive) { setComponent(null); setDiagnostics([{ message: reason instanceof Error ? reason.message : 'Could not compile the workspace app' }]); } });
    return () => { alive = false; };
  }, [services, source]);

  return <aside className="absolute inset-y-0 end-0 z-30 flex w-full max-w-xl flex-col border-s bg-card shadow-2xl lg:relative lg:inset-auto lg:w-[min(34rem,42vw)] lg:shadow-none" aria-label="Workspace preview"><header className="flex h-16 shrink-0 items-center gap-3 border-b px-4"><Code2 className="size-4 text-primary" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold">Workspace</p><p className="truncate text-xs text-muted-foreground">/work/src/App.tsx · live preview</p></div><Button variant="ghost" size="icon" aria-label="Close workspace" onClick={onClose}><XCircle /></Button></header><div className="flex min-h-0 flex-1 flex-col gap-3 p-3"><div className="flex items-center justify-between text-xs text-muted-foreground"><span>Live preview of your default export</span><span>{diagnostics.length ? `${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'}` : component ? 'Ready' : 'Compiling…'}</span></div><div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-background">{diagnostics.length ? <div className="space-y-2 p-4 text-xs text-destructive">{diagnostics.map((diagnostic, index) => <p key={`${diagnostic.message}-${index}`}>{diagnostic.line ? `${diagnostic.line}:${diagnostic.column ?? 1} ` : ''}{diagnostic.message}</p>)}</div> : <><iframe ref={frameRef} title="Workspace app preview" sandbox="allow-scripts allow-same-origin" srcDoc="<!doctype html><html><head><style>html,body{margin:0;min-height:100%;box-sizing:border-box}body{padding:16px}</style></head><body></body></html>" onLoad={handleFrameLoad} className="size-full border-0" />{frameBody && component ? createPortal(<PreviewErrorBoundary key={source}><PreviewHost node={component} /></PreviewErrorBoundary>, frameBody) : null}</>}</div></div></aside>;
}

type ChatPageProps = { services: ChatPageServices };

export function ChatPage({ services }: ChatPageProps) {
  const [user, setUser] = useState<UiUser | null>(() => services.auth.currentUser());
  const [authLoading, setAuthLoading] = useState(true);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [conversations, setConversations] = useState<UiConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => conversationIdFromUrl());
  const [messages, setMessages] = useState<UiMessage[]>(starterMessages);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<ChatMode>('explore');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [planReadyMessageId, setPlanReadyMessageId] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [online, setOnline] = useState<UiPresence[]>([]);
  const [notice, setNotice] = useState<UiNotification | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef(messages);
  const activeConversationIdRef = useRef(activeConversationId);
  const retryRef = useRef<(() => void) | null>(null);
  const requestRef = useRef(0);

  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { activeConversationIdRef.current = activeConversationId; }, [activeConversationId]);

  useEffect(() => {
    setAuthLoading(true);
    return services.auth.observe((nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
    });
  }, [services]);

  useEffect(() => {
    if (!user) {
      setOnline([]);
      return;
    }
    const unsubscribe = services.presence.observe(setOnline);
    let alive = true;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      void services.notifications.enable((message) => {
        if (!alive) return;
        setNotice(message);
        window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 6000);
      }).then((enabled) => { if (alive) setNotificationsEnabled(enabled); }).catch(() => undefined);
    }
    return () => { alive = false; unsubscribe(); };
  }, [services, user]);

  useEffect(() => {
    const onPopState = () => setActiveConversationId(conversationIdFromUrl());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('popstate', onPopState);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    const request = ++requestRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    retryRef.current = null;
    setStreaming(false);
    setError(null);
    if (!user) {
      setConversations([]);
      setActiveConversationId(null);
      setMessages(starterMessages);
      setConversationLoading(false);
      setMessageLoading(false);
      return;
    }

    setConversationLoading(true);
    let alive = true;
    const applyList = (nextItems: UiConversation[]) => {
      if (!alive || request !== requestRef.current) return;
      const items = nextItems.filter((item) => item.id !== deletingConversationId);
      setConversations(items);
      const currentId = activeConversationIdRef.current;
      const nextId = currentId && items.some((item) => item.id === currentId) ? currentId : items[0]?.id ?? null;
      activeConversationIdRef.current = nextId;
      setActiveConversationId(nextId);
      if (conversationIdFromUrl() !== nextId) writeConversationUrl(nextId, true);
      setConversationLoading(false);
    };
    void services.conversations.list().then(applyList).catch((reason: unknown) => {
      if (alive) { setError(errorMessage(reason, 'Could not load conversations')); setConversationLoading(false); }
    });
    const unsubscribe = services.conversations.observeList(applyList);
    return () => { alive = false; unsubscribe(); };
  }, [deletingConversationId, services, user]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    retryRef.current = null;
    setStreaming(false);
    setPlanReadyMessageId(null);
    setMessages(starterMessages);
    if (!user || !activeConversationId) { setMessageLoading(false); return; }

    let alive = true;
    setMessageLoading(true);
    const unsubscribeMessages = services.messages.observeRecent(activeConversationId, (nextMessages) => {
      if (!alive) return;
      setMessages((current) => reconcileMessages(nextMessages, current));
      setMessageLoading(false);
    });
    const unsubscribeConversation = services.conversations.observe(activeConversationId, (conversation) => {
      setConversations((current) => current.map((item) => item.id === conversation.id ? conversation : item));
    });
    return () => { alive = false; unsubscribeMessages(); unsubscribeConversation(); };
  }, [activeConversationId, services, user]);

  const activeConversation = useMemo(() => conversations.find((conversation) => conversation.id === activeConversationId), [activeConversationId, conversations]);
  const messageRevision = useMemo(() => messages.map((message) => `${message.id}:${message.text.length}:${message.thoughts?.length ?? 0}:${message.status ?? ''}`).join('|'), [messages]);

  const refreshConversations = async () => {
    const items = await services.conversations.list();
    setConversations((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      items.forEach((item) => byId.set(item.id, item));
      return [...byId.values()];
    });
  };

  const startConversation = async () => {
    if (!user || streaming) return;
    setError(null);
    try {
      const id = await services.conversations.create();
      await refreshConversations();
      setActiveConversationId(id);
      writeConversationUrl(id);
    } catch (reason) { setError(errorMessage(reason, 'Could not start a conversation')); }
  };

  const selectConversation = (id: string) => {
    if (id === activeConversationId) return;
    abortRef.current?.abort();
    setActiveConversationId(id);
    writeConversationUrl(id);
    if (window.innerWidth < 640) setSidebarOpen(false);
  };

  const deleteConversation = async (id: string) => {
    if (!user || deletingConversationId) return;
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation || !window.confirm(`Delete “${conversation.title}” and all its messages?`)) return;
    setDeletingConversationId(id);
    setError(null);
    const deletingActive = id === activeConversationId;
    if (deletingActive) {
      abortRef.current?.abort();
      abortRef.current = null;
      retryRef.current = null;
      setStreaming(false);
      setMessages(starterMessages);
      setActiveConversationId(null);
      writeConversationUrl(null, true);
    }
    try {
      await services.conversations.delete(id);
      const remaining = conversations.filter((item) => item.id !== id);
      setConversations(remaining);
      if (deletingActive) {
        const nextId = remaining[0]?.id ?? null;
        activeConversationIdRef.current = nextId;
        setActiveConversationId(nextId);
        writeConversationUrl(nextId, true);
      }
    } catch (reason) {
      setError(errorMessage(reason, 'Could not delete conversation'));
    } finally {
      setDeletingConversationId(null);
    }
  };

  const streamAssistant = async (conversationId: string, history: Pick<UiMessage, 'role' | 'text'>[], placeholderId: string, selectedMode: ChatMode) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    let streamedText = '';
    let streamedThoughts = '';
    retryRef.current = () => {
      void streamAssistant(conversationId, history, placeholderId, selectedMode).catch(() => undefined);
    };
    try {
      const result = await services.ai.stream({ conversationId, messages: history, mode: selectedMode, signal: controller.signal }, (chunk) => {
        streamedText += chunk;
        setMessages((current) => current.map((message) => message.id === placeholderId ? { ...message, text: streamedText, status: 'streaming' } : message));
      }, (thought) => {
        streamedThoughts += thought;
        setMessages((current) => current.map((message) => message.id === placeholderId ? { ...message, thoughts: `${message.thoughts ?? ''}${thought}`, status: 'streaming' } : message));
      }, (tool) => {
        setMessages((current) => current.map((message) => {
          if (message.id !== placeholderId) return message;
          const toolCalls = [...(message.toolCalls ?? [])];
          const index = toolCalls.findIndex((call) => call.id === tool.id);
          if (index === -1) toolCalls.push(tool);
          else toolCalls[index] = { ...toolCalls[index], ...tool };
          return { ...message, toolCalls, status: 'streaming' };
        }));
      }, (usage) => {
        setMessages((current) => current.map((message) => message.id === placeholderId ? { ...message, usage } : message));
      }, () => {
        setWorkspaceRevision((value) => value + 1);
        setWorkspaceOpen(true);
      });
      const thoughts = streamedThoughts || result.thoughts;
      await services.messages.appendAssistantMessage({ conversationId, text: result.text || streamedText, clientMessageId: placeholderId, thoughts, model: result.model, finishReason: result.finishReason, inputTokenCount: result.inputTokenCount, outputTokenCount: result.outputTokenCount });
      setMessages((current) => current.map((message) => message.id === placeholderId ? { ...message, text: result.text || streamedText, thoughts: thoughts ?? message.thoughts, usage: result.usage ?? message.usage, status: 'complete' } : message));
      if (selectedMode === 'plan') setPlanReadyMessageId(placeholderId);
      retryRef.current = null;
    } catch (reason) {
      const stopped = isAbort(reason);
      const text = streamedText || (stopped ? 'Generation stopped.' : 'I could not complete that response.');
      setMessages((current) => current.map((message) => message.id === placeholderId ? { ...message, text, status: 'error' } : message));
      if (!stopped) setError(errorMessage(reason, 'Could not send message'));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setStreaming(false);
    }
  };

  const sendMessage = async (textOverride?: string, modeOverride: ChatMode = mode) => {
    const text = (textOverride ?? draft).trim();
    if (!text || !user || streaming) return;
    setDraft('');
    textareaRef.current?.focus();
    setError(null);
    let conversationId = activeConversationId;
    let placeholderId: string | null = null;
    try {
      if (!conversationId) {
        conversationId = await services.conversations.create({ title: text.slice(0, 48) });
        await refreshConversations();
        setActiveConversationId(conversationId);
      }
      const clientMessageId = crypto.randomUUID();
      const userMessage: UiMessage = { id: clientMessageId, role: 'user', text, status: 'complete', clientMessageId };
      const history = [...messagesRef.current.filter((message) => message.id !== 'welcome' && message.status !== 'error'), userMessage];
      const assistantPlaceholderId = `assistant-${clientMessageId}`;
      placeholderId = assistantPlaceholderId;
      setMessages((current) => [...current.filter((message) => message.id !== 'welcome'), userMessage, { id: assistantPlaceholderId, role: 'assistant', text: '', status: 'streaming', replyToClientMessageId: clientMessageId }]);
      await services.messages.appendUserMessage({ conversationId, text, clientMessageId });
      await streamAssistant(conversationId, history, assistantPlaceholderId, modeOverride);
    } catch (reason) {
      if (!isAbort(reason)) {
        setError(errorMessage(reason, 'Could not send message'));
        if (placeholderId) setMessages((current) => current.map((message) => message.id === placeholderId ? { ...message, text: 'Message could not be saved.', status: 'error' } : message));
      }
    }
  };

  const stopStreaming = () => abortRef.current?.abort();
  const enableNotifications = async () => {
    setNotificationsBusy(true);
    setError(null);
    try {
      const enabled = await services.notifications.enable((message) => {
        setNotice(message);
        window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 6000);
      });
      setNotificationsEnabled(enabled);
      if (enabled) {
        await services.notifications.showEnabledConfirmation();
      } else if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        setError('Notifications are blocked for localhost. Allow them in Chrome site settings, then reload.');
      } else if (!enabled) {
        setError('Notifications are unavailable in this browser.');
      }
    } catch (reason) {
      setError(errorMessage(reason, 'Could not enable notifications'));
    } finally {
      setNotificationsBusy(false);
    }
  };
  const signIn = async () => { setError(null); try { await services.auth.signIn(); } catch (reason) { setError(errorMessage(reason, 'Could not sign in')); } };
  const signOut = async () => {
    abortRef.current?.abort();
    setUser(null);
    setNotificationsEnabled(false);
    try { await services.auth.signOut(); } catch (reason) { setError(errorMessage(reason, 'Could not sign out')); }
  };

  return (
    <main className="relative flex h-svh overflow-hidden bg-background text-foreground">
      {sidebarOpen && <button type="button" aria-label="Close conversation sidebar" className="fixed inset-0 z-10 bg-black/25 sm:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside className={`${sidebarOpen ? 'w-72' : 'w-0'} absolute inset-y-0 start-0 z-20 flex shrink-0 flex-col overflow-hidden border-e bg-card shadow-xl transition-[width] duration-200 sm:relative sm:inset-auto sm:z-auto sm:shadow-none`}>
        <div className="flex h-16 items-center justify-between border-b px-4"><div><p className="text-sm font-semibold tracking-tight">PyChat</p><p className="text-xs text-muted-foreground">Private AI workspace</p></div><Button variant="ghost" size="icon" aria-label="Close conversation sidebar" onClick={() => setSidebarOpen(false)}><PanelLeftClose /></Button></div>
        <div className="p-3"><Button className="w-full justify-start gap-2" variant="outline" onClick={() => void startConversation()} disabled={!user || streaming}><MessageSquarePlus /> New conversation</Button></div>
        <nav aria-label="Conversations" className="flex-1 space-y-1 overflow-y-auto px-2">{conversations.map((conversation) => <div key={conversation.id} className={`group flex items-center gap-1 rounded-lg text-sm transition-colors ${conversation.id === activeConversationId ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}><button className="min-w-0 flex-1 px-3 py-2 text-start" onClick={() => selectConversation(conversation.id)}><span className="block truncate font-medium">{conversation.title}</span><span className="mt-0.5 block text-xs opacity-70">{conversation.updatedAt ? formatTime(conversation.updatedAt) : 'Just now'}</span></button><Button variant="ghost" size="icon" className="me-1 size-8 shrink-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Delete conversation ${conversation.title}`} disabled={deletingConversationId !== null} onClick={() => void deleteConversation(conversation.id)}><Trash2 /></Button></div>)}{!conversations.length && !conversationLoading && <p className="px-3 py-8 text-center text-xs text-muted-foreground">No conversations yet. Start one to develop an idea.</p>}</nav>
        <div className="border-t p-3">{user ? <div className="flex items-center gap-2"><div className="relative shrink-0"><div className="grid size-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{initials(user)}</div><span className="absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500" aria-hidden="true" /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{user.displayName ?? 'Signed in'}</p><p className="truncate text-xs text-muted-foreground">{online.length} online · {user.email}</p></div><Button variant="ghost" size="icon" aria-label="Sign out" onClick={() => void signOut()}><LogOut /></Button></div> : <Button className="w-full gap-2" onClick={() => void signIn()} disabled={authLoading}><LogIn /> Sign in to continue</Button>}</div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6">{!sidebarOpen && <Button variant="ghost" size="icon" aria-label="Open conversation sidebar" onClick={() => setSidebarOpen(true)}><PanelLeftOpen /></Button>}<div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{activeConversation?.title ?? 'New conversation'}</p><p className="text-xs text-muted-foreground">Private thinking space · {modeOptions.find((option) => option.id === mode)?.label}</p></div><Button variant={notificationsEnabled ? 'secondary' : 'ghost'} size="icon" aria-label={notificationsEnabled ? 'Send test notification' : 'Enable notifications'} title={notificationsEnabled ? 'Send test notification' : 'Enable notifications'} disabled={!user || notificationsBusy} onClick={() => void enableNotifications()}>{notificationsBusy ? <LoaderCircle className="animate-spin" /> : <Bell />}</Button><Button variant={workspaceOpen ? 'secondary' : 'ghost'} size="icon" aria-label={workspaceOpen ? 'Workspace open' : 'Open workspace'} title="Open workspace" onClick={() => setWorkspaceOpen((open) => !open)}><Code2 /></Button></header>
        {notice && <div role="status" className="chat-message-in border-b bg-primary/5 px-4 py-2.5 sm:px-6"><div className="mx-auto flex max-w-3xl items-start gap-3"><Bell className="mt-0.5 size-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{notice.title}</p>{notice.body && <p className="truncate text-xs text-muted-foreground">{notice.body}</p>}</div><Button variant="ghost" size="icon-xs" aria-label="Dismiss notification" onClick={() => setNotice(null)}><XCircle /></Button></div></div>}
        <MessageScrollerProvider autoScroll><MessageScroller className="min-h-0 flex-1"><StreamingFollow revision={messageRevision} streaming={streaming} /><MessageScrollerViewport className="px-4 py-8 sm:px-8"><MessageScrollerContent className="mx-auto w-full max-w-3xl gap-8"><MessageScrollerItem messageId="intro" scrollAnchor={messages.length <= 1}><div className="mx-auto max-w-xl py-16 text-center"><div className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm"><span className="text-lg">✦</span></div><h1 className="text-2xl font-semibold tracking-tight">A clearer place to think.</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">Explore possibilities, turn ideas into plans, or pressure-test a direction. Your context stays with you across conversations.</p></div></MessageScrollerItem><MessageGroup className="gap-8">{messages.map((message, index) => <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'} className="chat-message-in" style={{ animationDelay: `${Math.min(index * 35, 350)}ms` }}><Message align={message.role === 'user' ? 'end' : 'start'}><MessageAvatar className={message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}><span className="grid size-8 place-items-center text-xs font-semibold">{message.role === 'user' ? initials(user) : '✦'}</span></MessageAvatar><MessageContent className={message.role === 'assistant' ? 'w-full max-w-[min(42rem,78%)]' : 'w-fit max-w-[min(42rem,78%)]'}><MessageHeader>{message.role === 'user' ? 'You' : 'PyChat'}</MessageHeader>{message.role === 'assistant' && message.toolCalls && <ToolActivity calls={message.toolCalls} />}{message.role === 'assistant' && message.thoughts && <ThoughtsDisclosure thoughts={message.thoughts} streaming={message.status === 'streaming'} />}<div className={`w-fit max-w-full rounded-xl px-4 py-3 leading-7 shadow-sm ${message.role === 'user' ? 'bg-primary text-primary-foreground' : 'border-transparent bg-muted text-foreground'}`}>{message.text ? message.role === 'assistant' ? <MarkdownMessage content={message.text} /> : <p className="whitespace-pre-wrap text-sm">{message.text}</p> : <span className="inline-flex gap-1 text-muted-foreground"><i className="size-1.5 animate-pulse rounded-full bg-current" /><i className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" /><i className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" /></span>}</div>{message.status === 'streaming' && <MessageFooter>Thinking…</MessageFooter>}{message.status === 'error' && <MessageFooter><span role="alert">Response unavailable.</span><Button variant="ghost" size="sm" onClick={() => retryRef.current?.()}>Retry</Button></MessageFooter>}{message.role === 'assistant' && message.usage && <MessageFooter><UsageSummary usage={message.usage} /></MessageFooter>}<div className={message.role === 'user' ? 'self-end' : 'self-start'}><CopyMessageButton text={message.text} /></div>{message.role === 'assistant' && planReadyMessageId && (message.id === planReadyMessageId || message.clientMessageId === planReadyMessageId) && <StartPlanCard onStart={() => { setPlanReadyMessageId(null); void sendMessage('Start the plan above. Begin with the first actionable step.', 'plan'); }} onDecline={() => setPlanReadyMessageId(null)} onSendDirection={(direction) => { setPlanReadyMessageId(null); void sendMessage(direction, 'plan'); }} />}</MessageContent></Message></MessageScrollerItem>)}</MessageGroup></MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton /></MessageScroller></MessageScrollerProvider>
        <div className="border-t bg-background/90 p-4 backdrop-blur sm:px-8"><div className="mx-auto max-w-3xl">{error && <p role="alert" className="mb-2 text-xs text-destructive">{error}</p>}<div className="mb-2 flex flex-wrap items-center gap-1" role="tablist" aria-label="Thinking mode">{modeOptions.map((option) => <button key={option.id} type="button" role="tab" aria-selected={mode === option.id} title={option.description} disabled={!user || streaming} onClick={() => { setMode(option.id); setPlanReadyMessageId(null); }} className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${mode === option.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>{option.label}</button>)}</div><div className="relative rounded-xl border bg-card shadow-sm focus-within:ring-2 focus-within:ring-ring/30"><textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} disabled={!user || streaming} rows={3} placeholder={user ? modeOptions.find((option) => option.id === mode)?.placeholder : 'Sign in to start a private conversation'} aria-label="Message" className="min-h-24 w-full resize-none bg-transparent px-4 pb-12 pt-4 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed" /><div className="absolute inset-x-3 bottom-3 flex items-center justify-between"><span className="text-xs text-muted-foreground">Enter to send · Shift + Enter for a new line</span>{streaming ? <Button variant="secondary" size="icon" aria-label="Stop generating" onClick={stopStreaming}><Square /></Button> : <Button size="icon" aria-label="Send message" disabled={!user || !draft.trim() || messageLoading} onClick={() => void sendMessage()}><ArrowUp /></Button>}</div></div><p className="mt-2 text-center text-[11px] text-muted-foreground">PyChat helps you explore, plan, and refine. Check important information.</p></div></div>
      </section>
      {workspaceOpen && <PreviewErrorBoundary><WorkspacePreview services={services} revision={workspaceRevision} onClose={() => setWorkspaceOpen(false)} /></PreviewErrorBoundary>}
    </main>
  );
}
