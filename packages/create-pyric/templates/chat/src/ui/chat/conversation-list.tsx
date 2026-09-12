import type { Ref } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatTime } from './chat-format';
import type { UiConversation } from './chat-types';

type ConversationItemProps = {
  conversation: UiConversation;
  active: boolean;
  deleteDisabled: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

/** One row of the sidebar: the button that opens a conversation, and the control that deletes it. */
function ConversationItem({ conversation, active, deleteDisabled, onSelect, onDelete }: ConversationItemProps) {
  return (
    <div className={`group flex items-center gap-1 rounded-lg text-sm transition-colors ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}><button className="min-w-0 flex-1 px-3 py-2 text-start" onClick={() => onSelect(conversation.id)}><span className="block truncate font-medium">{conversation.title}</span><span className="mt-0.5 block text-xs opacity-70">{conversation.updatedAt ? formatTime(conversation.updatedAt) : 'Just now'}</span></button><Button variant="ghost" size="icon" className="me-1 size-8 shrink-0 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Delete conversation ${conversation.title}`} disabled={deleteDisabled} onClick={() => onDelete(conversation.id)}><Trash2 /></Button></div>
  );
}

type ConversationListProps = {
  ref?: Ref<HTMLElement>;
  conversations: UiConversation[];
  activeConversationId: string | null;
  deletingConversationId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

/** The sidebar's list of conversations. Its root element is the one the
 *  conversation-list listener feeds, so the page passes a ref for it. */
export function ConversationList({ ref, conversations, activeConversationId, deletingConversationId, loading, onSelect, onDelete }: ConversationListProps) {
  return (
    <nav ref={ref} id="conversations" aria-label="Conversations" className="flex-1 space-y-1 overflow-y-auto px-2">{conversations.map((conversation) => <ConversationItem key={conversation.id} conversation={conversation} active={conversation.id === activeConversationId} deleteDisabled={deletingConversationId !== null} onSelect={onSelect} onDelete={onDelete} />)}{!conversations.length && !loading && <p className="px-3 py-8 text-center text-xs text-muted-foreground">No conversations yet. Start one to develop an idea.</p>}</nav>
  );
}
