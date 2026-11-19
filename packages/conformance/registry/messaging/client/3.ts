import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["deleteToken"],
  flipped: 'oracle-backed',
  api: 'deleteToken(messaging): Promise<boolean>',
  behavior:
    'Deletes the registration token and unsubscribes the instance from its push subscription; resolves truthy. After deletion no message reaches the client on either route, and a server send to the now-dead token eventually surfaces the UNREGISTERED / 404-class error on the send plane (propagation is asynchronous — the first send after delete may still be accepted while delivery has already stopped).',
  evidence:
    'oracle: `messaging-web-deletetoken-unregistered.json` (deleteToken resolved truthy; no delivery to client; send plane eventually UNREGISTERED). Replayed by the conformance suite.',
  notes: 'The committed observation\'s description is out of date: it lists a firebase-admin re-wrap as stable, while its behavior records `adminSendThrows: false`. The harness text is corrected and applies at the next capture, which also records `firstSendStatus`.',
  observations: ['messaging-web-deletetoken-unregistered'],
});
