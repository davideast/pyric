import { ChatPage } from './chat/chat-page';
import { createFirebaseChatGateway } from './chat/firebase-chat-gateway';

const services = createFirebaseChatGateway();

export function App() {
  return <ChatPage services={services} />;
}
