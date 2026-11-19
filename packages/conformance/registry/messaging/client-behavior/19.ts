import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getToken", "onMessage"],
  api: 'Multi-device delivery (one app instance holding several tokens; per-token fan-out)',
  behavior:
    'A single user or app can hold several registration tokens at once — one per browser, profile, or device. A token-targeted send reaches exactly one token; a topic, condition, or multicast send fans out independently to every subscribed token, with no server-side de-duplication across a user’s devices, so each device receives its own copy. Stated from the FCM targeting model; no committed observation replays cross-device fan-out yet.',
  evidence:
    'Upstream documentation (FCM targeting model); no observation yet. Candidate probe: mint two distinct tokens, subscribe both to one topic, send once, and assert each token receives the message independently.',
  riskReasons: [
    'Per-token multi-device fan-out and the absence of cross-device de-duplication stated from FCM documentation only; no committed observation — a probe candidate before implementation.',
  ],
  notes:
    'Candidate capture for the re-capture lane (#444): two tokens subscribed to one topic, a single send, asserting independent per-token delivery.',
});
