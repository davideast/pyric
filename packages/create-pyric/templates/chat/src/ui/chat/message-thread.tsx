import { useEffect, useRef, useState, type Ref } from 'react';
import { Check, CheckCircle2, ChevronsUpDown, Copy, LoaderCircle, TerminalSquare, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Message, MessageAvatar, MessageContent, MessageFooter, MessageGroup, MessageHeader } from '@/components/ui/message';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller, useMessageScrollerScrollable } from '@/components/ui/message-scroller';
import { initials } from './chat-format';
import type { UiMessage, UiToolCall, UiUsage, UiUser } from './chat-types';
import { MarkdownMessage } from './markdown-message';

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

type MessageBubbleProps = {
  message: UiMessage;
  user: UiUser | null;
  planReady: boolean;
  onRetry: () => void;
  onStartPlan: () => void;
  onDeclinePlan: () => void;
  onSendDirection: (direction: string) => void;
};

/** One message in the thread, with its tool activity, thoughts, usage, and the
 *  plan card the assistant offers after a plan turn. */
function MessageBubble({ message, user, planReady, onRetry, onStartPlan, onDeclinePlan, onSendDirection }: MessageBubbleProps) {
  return (
    <Message align={message.role === 'user' ? 'end' : 'start'}><MessageAvatar className={message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'}><span className="grid size-8 place-items-center text-xs font-semibold">{message.role === 'user' ? initials(user) : '✦'}</span></MessageAvatar><MessageContent className={message.role === 'assistant' ? 'w-full max-w-[min(42rem,78%)]' : 'w-fit max-w-[min(42rem,78%)]'}><MessageHeader>{message.role === 'user' ? 'You' : 'PyChat'}</MessageHeader>{message.role === 'assistant' && message.toolCalls && <ToolActivity calls={message.toolCalls} />}{message.role === 'assistant' && message.thoughts && <ThoughtsDisclosure thoughts={message.thoughts} streaming={message.status === 'streaming'} />}<div className={`w-fit max-w-full rounded-xl px-4 py-3 leading-7 shadow-sm ${message.role === 'user' ? 'bg-primary text-primary-foreground' : 'border-transparent bg-muted text-foreground'}`}>{message.text ? message.role === 'assistant' ? <MarkdownMessage content={message.text} /> : <p className="whitespace-pre-wrap text-sm">{message.text}</p> : <span className="inline-flex gap-1 text-muted-foreground"><i className="size-1.5 animate-pulse rounded-full bg-current" /><i className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" /><i className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" /></span>}</div>{message.status === 'streaming' && <MessageFooter>Thinking…</MessageFooter>}{message.status === 'error' && <MessageFooter><span role="alert">Response unavailable.</span><Button variant="ghost" size="sm" onClick={onRetry}>Retry</Button></MessageFooter>}{message.role === 'assistant' && message.usage && <MessageFooter><UsageSummary usage={message.usage} /></MessageFooter>}<div className={message.role === 'user' ? 'self-end' : 'self-start'}><CopyMessageButton text={message.text} /></div>{message.role === 'assistant' && planReady && <StartPlanCard onStart={onStartPlan} onDecline={onDeclinePlan} onSendDirection={onSendDirection} />}</MessageContent></Message>
  );
}

type MessageThreadProps = {
  ref?: Ref<HTMLDivElement>;
  messages: UiMessage[];
  user: UiUser | null;
  streaming: boolean;
  revision: string;
  planReadyMessageId: string | null;
  onRetry: () => void;
  onStartPlan: () => void;
  onDeclinePlan: () => void;
  onSendDirection: (direction: string) => void;
};

/** The scrolling thread: the intro, then one bubble per message. Its root
 *  element is the one the message listener feeds. */
export function MessageThread({ ref, messages, user, streaming, revision, planReadyMessageId, onRetry, onStartPlan, onDeclinePlan, onSendDirection }: MessageThreadProps) {
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col"><MessageScrollerProvider autoScroll><MessageScroller className="min-h-0 flex-1"><StreamingFollow revision={revision} streaming={streaming} /><MessageScrollerViewport className="px-4 py-8 sm:px-8"><MessageScrollerContent className="mx-auto w-full max-w-3xl gap-8"><MessageScrollerItem messageId="intro" scrollAnchor={messages.length <= 1}><div className="mx-auto max-w-xl py-16 text-center"><div className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm"><span className="text-lg">✦</span></div><h1 className="text-2xl font-semibold tracking-tight">A clearer place to think.</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">Explore possibilities, turn ideas into plans, or pressure-test a direction. Your context stays with you across conversations.</p></div></MessageScrollerItem><MessageGroup className="gap-8">{messages.map((message, index) => <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={message.role === 'user'} className="chat-message-in" style={{ animationDelay: `${Math.min(index * 35, 350)}ms` }}><MessageBubble message={message} user={user} planReady={Boolean(planReadyMessageId) && (message.id === planReadyMessageId || message.clientMessageId === planReadyMessageId)} onRetry={onRetry} onStartPlan={onStartPlan} onDeclinePlan={onDeclinePlan} onSendDirection={onSendDirection} /></MessageScrollerItem>)}</MessageGroup></MessageScrollerContent></MessageScrollerViewport><MessageScrollerButton /></MessageScroller></MessageScrollerProvider></div>
  );
}
