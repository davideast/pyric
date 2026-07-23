import { FirebaseAuthService } from '@/services/auth-service';
import { createProvisioner } from '@/services/provisioning';
import { ConversationService } from '@/services/conversation-service';
import { MessageService } from '@/services/message-service';
import { UserService } from '@/services/user-service';
import { PresenceService } from '@/services/presence-service';
import { NotificationService } from '@/services/notification-service';
import { BrowserAgentService } from '@/services/browser-agent-service';
import { asConversationId, type AuthUser, type Conversation, type Message, type PresenceEntry } from '@/firebase/types';
import type { ChatPageServices, UiConversation, UiMessage, UiPresence, UiUser } from './chat-types';

const toUiUser = (user: AuthUser | null): UiUser | null =>
  user
    ? { displayName: user.displayName, email: user.email, photoURL: user.photoURL }
    : null;

const toUiPresence = (entry: PresenceEntry): UiPresence => ({ uid: entry.uid, displayName: entry.displayName });

const toUiConversation = (conversation: Conversation): UiConversation => ({
  id: conversation.id,
  title: conversation.title,
  updatedAt: conversation.updatedAt?.toDate(),
});

const toUiMessage = (message: Message): UiMessage => ({
  id: message.id,
  role: message.role,
  text: message.text,
  createdAt: message.createdAt?.toDate(),
  status: 'complete',
  clientMessageId: message.clientMessageId ?? undefined,
  thoughts: message.thoughts ?? undefined,
  usage: message.inputTokenCount !== null || message.outputTokenCount !== null
    ? { inputTokens: message.inputTokenCount ?? 0, outputTokens: message.outputTokenCount ?? 0 }
    : undefined,
});

export const createFirebaseChatGateway = (): ChatPageServices => {
  const auth = new FirebaseAuthService();
  const conversations = new ConversationService();
  const messages = new MessageService();
  const ai = new BrowserAgentService();
  const users = new UserService();
  const presence = new PresenceService();
  const notifications = new NotificationService();
  const provision = createProvisioner(async (user: AuthUser) => {
    await users.provision(user);
    await presence.goOnline(user);
  });

  return {
    auth: {
      currentUser: () => toUiUser(auth.currentUser()),
      // Auth state reports the signed-in user as soon as Firebase does; a
      // provisioning failure must not masquerade as "signed out". The signIn
      // path awaits the same shared attempt, so its failure surfaces in the
      // sign-in error UI rather than only here.
      observe: (callback) => auth.observe((user) => {
        if (!user) {
          callback(null);
          return;
        }
        callback(toUiUser(user));
        provision(user).catch((error: unknown) => {
          console.error('Post-sign-in provisioning failed; the user profile or presence may be missing.', error);
        });
      }),
      signIn: async () => {
        const signedIn = await auth.signIn();
        await provision(signedIn);
        const user = toUiUser(signedIn);
        if (!user) throw new Error('Unable to sign in');
        return user;
      },
      signOut: async () => {
        await presence.goOffline().catch(() => undefined);
        await auth.signOut();
      },
    },
    presence: {
      observe: (callback) => presence.observe((entries) => callback(entries.map(toUiPresence))),
    },
    notifications: {
      enable: async (onMessage) => (await notifications.enable((message) => onMessage({ title: message.title, body: message.body }))) !== null,
      showEnabledConfirmation: () => notifications.showEnabledConfirmation(),
    },
    conversations: {
      list: async () => (await conversations.list()).items.map(toUiConversation),
      create: (input) => conversations.create(input),
      delete: (id) => conversations.delete(id as Conversation['id']),
      observe: (id, callback) => conversations.observe(id as Conversation['id'], (value) => callback(toUiConversation(value))),
      observeList: (callback) => conversations.observeList((values) => callback(values.map(toUiConversation))),
    },
    messages: {
      list: async (conversationId) => (await messages.list(conversationId)).items.map(toUiMessage),
      appendUserMessage: (input) => messages.appendUserMessage({ ...input, conversationId: asConversationId(input.conversationId) }),
      appendAssistantMessage: (input) => messages.appendAssistantMessage({ ...input, conversationId: asConversationId(input.conversationId) }),
      observeRecent: (conversationId, callback) => messages.observeRecent(conversationId, (value) => callback(value.map(toUiMessage))),
    },
    ai: {
      stream: async (input, onChunk, onThought, onTool, onUsage, onWorkspaceChanged) => {
        const result = await ai.stream(input, { onChunk, onThought, onTool, onUsage, onWorkspaceChanged });
        return { text: result.text, thoughts: result.thoughts, model: 'gemini-2.5-flash', finishReason: 'stop', usage: result.usage, inputTokenCount: result.usage?.inputTokens ?? null, outputTokenCount: result.usage?.outputTokens ?? null };
      },
    },
    workspace: {
      readAppSource: () => ai.readAppSource(),
      previewApp: (source, hostModules) => ai.previewApp(source, hostModules),
      subscribe: (callback) => ai.subscribe(callback),
    },
  };
};
