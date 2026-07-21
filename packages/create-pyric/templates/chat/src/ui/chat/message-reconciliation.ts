import type { UiMessage } from './chat-types';

export const starterMessages: UiMessage[] = [{
  id: 'welcome',
  role: 'assistant',
  text: 'Good morning. What would you like to work through?',
  status: 'complete',
}];

const chronological = (items: UiMessage[]): UiMessage[] => [...items].sort((a, b) => {
  if (!a.createdAt || !b.createdAt) return 0;
  return a.createdAt.getTime() - b.createdAt.getTime();
});

export const reconcileMessages = (
  serverMessages: UiMessage[],
  currentMessages: UiMessage[],
): UiMessage[] => {
  const seenServerMessages = new Set<string>();
  const server = chronological(serverMessages).filter((message) => {
    if (!message.clientMessageId) return true;
    const key = `${message.role}:${message.clientMessageId}`;
    if (seenServerMessages.has(key)) return false;
    seenServerMessages.add(key);
    return true;
  });
  const serverIds = new Set(server.map((message) => message.id));
  const serverClientIds = new Set(server.map((message) => message.clientMessageId).filter(Boolean));
  const localAssistants = currentMessages.filter((message) => message.role === 'assistant' && message.id !== 'welcome');
  const persistedAssistantIds = new Set(server.filter((message) => message.role === 'assistant').map((message) => message.clientMessageId).filter(Boolean));
  const linkedAssistants = new Set<string>();
  const result: UiMessage[] = [];

  const addReply = (message: UiMessage) => {
    for (const assistant of localAssistants) {
      if (assistant.replyToClientMessageId === message.clientMessageId && !persistedAssistantIds.has(assistant.id)) {
        result.push(assistant);
        linkedAssistants.add(assistant.id);
      }
    }
  };

  for (const message of server) {
    result.push(message);
    if (message.role === 'user') addReply(message);
  }

  for (const message of currentMessages) {
    if (message.role === 'user' && message.clientMessageId && !serverClientIds.has(message.clientMessageId)) {
      result.push(message);
      addReply(message);
    }
  }

  // React state contains both optimistic assistants and the previous listener
  // result. Keep only assistants that are genuinely absent from this snapshot.
  result.push(...localAssistants.filter((message) =>
    !serverIds.has(message.id)
    && !linkedAssistants.has(message.id)
    && !message.replyToClientMessageId));

  const turnKey = (message: UiMessage): string => {
    if (message.role === 'assistant') {
      if (message.replyToClientMessageId) return message.replyToClientMessageId;
      if (message.clientMessageId?.startsWith('assistant-')) return message.clientMessageId.slice('assistant-'.length);
    }
    return message.clientMessageId ?? message.id;
  };
  const turnOrder = new Map<string, number>();
  result.forEach((message, index) => {
    const key = turnKey(message);
    if (!turnOrder.has(key)) turnOrder.set(key, index);
  });
  return result.length ? [...result].sort((a, b) => {
    const orderDifference = (turnOrder.get(turnKey(a)) ?? 0) - (turnOrder.get(turnKey(b)) ?? 0);
    if (orderDifference !== 0) return orderDifference;
    if (a.role === 'user' && b.role !== 'user') return -1;
    if (a.role !== 'user' && b.role === 'user') return 1;
    return 0;
  }) : starterMessages;
};
