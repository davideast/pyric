import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getToken", "deleteToken"],
  api: 'Registration-token rotation and refresh over the app lifecycle',
  behavior:
    'A registration token is stable within a session (row messaging#2 pins that repeated `getToken` calls on one service-worker registration return the same token) but is not permanent across the app lifecycle: the SDK rotates it on events such as app reinstall, SDK upgrade, a restored backup, or a notification-permission change, and Google may retire a token server-side. The modular web SDK has no token-refresh callback, so an app observes a new token only by calling `getToken` again; a rotated-away old token eventually stops delivering and the send plane reports the dead token (the UNREGISTERED path pinned by messaging#3). This lifecycle rotation is deliberately outside the within-session stability observation. Stated from FCM token-management documentation; no committed observation replays rotation across lifecycle events yet.',
  evidence:
    'Upstream documentation (FCM token-management guidance); the committed `messaging-web-token-stability` observation covers only within-session stability, not lifecycle rotation. Candidate probe (long-horizon): force a service-worker unregister/re-register or an app-instance reset, re-mint via `getToken`, and record whether the token changed and whether the prior token then reports UNREGISTERED on send.',
  riskReasons: [
    'Token rotation/refresh across lifecycle events stated from FCM documentation only; the committed stability observation covers within-session stability, not rotation over time — a probe candidate for the scheduled re-capture lane (#444).',
  ],
  notes:
    'Candidate capture for the re-capture lane (#444), long-horizon: re-mint after a forced service-worker re-register / app reset and diff the token; assert the old token reports UNREGISTERED on the send plane.',
});
