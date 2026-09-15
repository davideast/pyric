# Teams workspace surface brief

## Purpose and status

A local collaboration surface for exercising Pyric observability through realistic team activity. This records the current implementation, with the working assumptions in `PRODUCT.md` still pending user feedback. The nine Brainwave frames listed in `DESIGN.md` remain the visual authority. The assistant extension draws its initial prompt and streaming-answer states from Brainwave nodes 296:81541, 422:176191, 422:176199, and 422:176189 within that existing charcoal identity.

## Composition

Navigation and channel groups sit at left, conversation occupies the center, and a contextual rail holds team details, threads, files, or reproducible scenarios. A bottom composer keeps sending close to the conversation. Search is a focused dialog. The account area shows the current Firebase user and Sign out. Developer identity controls live only in the injected chip. Small screens reveal navigation and context explicitly.

AI assistant navigation replaces the conversation and contextual rail with a prompt/answer workspace and visit-only chat history. The initial state offers three compact suggestions for a summary, next steps, or a reply. User and assistant turns use contrasting charcoal panels, with a persistent prompt composer below. At 1100px and below, a **Chats** control opens history in a modal side panel. Existing navigation, tonal surfaces, blue actions, and focus treatments carry through.

## Primary journey

Sign in, choose a channel, read activity, send a message or attachment, react, and open a thread. Presence, typing, and read receipts supply ephemeral feedback. Search returns matching messages. Scenario controls provide deliberate activity and failures to inspect through Pyric.

For assistance, choose a channel and open **AI assistant**. Send a suggestion or custom prompt, read the streaming answer, then follow up, copy, or regenerate the latest response. History lets the visitor return to earlier chats or start a new one. Loading and inline error/retry states keep request status visible. Answers are plain text and require review before sharing.

## Boundaries

Firestore owns durable content and RTDB owns ephemeral collaboration state. The normal Firebase app uses Pyric through the Vite development plugin. Keep the example isolated from concurrent runtime capture implementation. Avoid landing-page hero content and dashboard KPI cards: the first impression should be an inhabited team conversation.

Assistant history is component memory for this visit and identity, with no Firebase persistence or channel publishing. Each chat freezes up to 40 recent loaded messages at creation, capped at 1,200 text characters per message and 10,000 message-text characters total; attachments are excluded. Follow-ups retain that snapshot. The assistant cannot perform workspace actions.

Application code uses Firebase AI Logic (`firebase/ai`) with `gemini-2.5-flash`. Development Vite configuration routes requests to local Ollama (`ornith:9b`, default `http://localhost:11434/v1`); production uses real Firebase/Gemini and requires project setup. This extension changes no data schema or Pyric core behavior. AI-specific chip observability belongs to separate work; the existing injected chip remains the only developer control surface here.

## Review criteria

- Channel activity remains the visual center, with the composer available below its scroll region.
- Team, thread, file, search, and scenario states retain the same dark visual system.
- Assistant prompt, streaming response, history, and error states retain the same visual system and keep channel context visible.
- Narrow screens provide explicit navigation/context controls and readable message wrapping.
- Empty, error, disabled, hover, and keyboard-focus states remain distinguishable.
- Visual refinements preserve the user's reference direction without claiming unverified pixel parity.
