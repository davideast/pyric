import { onValueCreated } from 'firebase-functions/v2/database';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

// The Functions runtime provides the default admin app; the guard keeps the
// same source valid when deployed to production Cloud Functions.
if (getApps().length === 0) initializeApp();

/**
 * When a user first comes online, `/presence/{uid}` is created in Realtime
 * Database (see PresenceService.goOnline). That create fires this trigger,
 * which stamps the user's Firestore profile: `firstSeenAt` once, `lastSeenAt`
 * on every online transition.
 *
 * The write goes through the trusted admin SDK, so it bypasses the client
 * security rules in production — that is why `firstSeenAt` / `lastSeenAt` are
 * deliberately absent from the client-writable field lists in
 * firestore.modules.rules. Clients cannot forge them; only this function sets
 * them.
 */
export const onPresenceOnline = onValueCreated('/presence/{uid}', async (event) => {
  const { uid } = event.params;
  const profile = getFirestore().collection('users').doc(uid);
  const snapshot = await profile.get();
  const now = FieldValue.serverTimestamp();
  const seen = snapshot.exists && snapshot.data()?.firstSeenAt
    ? { lastSeenAt: now }
    : { firstSeenAt: now, lastSeenAt: now };
  await profile.set(seen, { merge: true });
});

/**
 * When the client persists an assistant reply it writes `/notify/{uid}/{pushId}`
 * in Realtime Database (see MessageService.notifyAssistantReply). That create
 * fires this trigger, which reads the owner's Cloud Messaging token from their
 * Firestore profile via the admin SDK (bypassing client security rules) and
 * sends an OS notification. The sandbox broker routes the send by tab
 * visibility: a hidden tab receives it on the background handler; a send
 * failure is swallowed so a bad token never crashes the functions child.
 */
export const notifyOnAssistantReply = onValueCreated('/notify/{uid}/{pushId}', async (event) => {
  const { uid } = event.params;
  const record = event.data.val();
  if (!record) return;
  try {
    const snap = await getFirestore().doc(`users/${uid}`).get();
    const token = snap.data()?.fcmToken;
    if (!token) return;
    await getMessaging().send({
      token,
      notification: { title: record.title ?? 'PyChat', body: record.body ?? '' },
    });
  } catch (error) {
    console.error('notifyOnAssistantReply failed', error);
  }
});
