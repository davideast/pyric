import { onValueCreated } from 'firebase-functions/v2/database';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

if (getApps().length === 0) initializeApp();

// Read the saved message: the client cannot choose notification text or tokens.
export const notifyMention = onValueCreated('/mentionRequests/{author}/{messageId}', async event => {
  const { author, messageId } = event.params;
  const channel = event.data.val();
  const knownChannel = ['design', 'general', 'launch'].includes(channel);
  if (!knownChannel) return;
  const snapshot = await getFirestore().doc(`workspaces/orbit/channels/${channel}/messages/${messageId}`).get();
  const message = snapshot.data();
  const ownsMessage = message?.author === author;
  const validMessage = ownsMessage && typeof message.text === 'string';
  if (!validMessage) return;
  const mentions = [...message.text.matchAll(/(?:^|\s)@([a-z0-9_-]+)\b/gi)];
  const recipients = new Set(mentions.map(match => match[1].toLowerCase()));
  recipients.delete(author);
  if (recipients.size === 0) return;
  const sender = await getAuth().getUser(author);
  for (const uid of recipients) {
    const registrations = await getDatabase().ref(`notificationTokens/${uid}`).get();
    const tokens = Object.entries(registrations.val() ?? {});
    for (const [device, token] of tokens) {
      if (typeof token !== 'string') continue;
      try {
        await getMessaging().send({
          token,
          data: {
            uid, channel, messageId,
            title: `${sender.displayName ?? 'A teammate'} mentioned you`,
            body: message.text.slice(0, 280),
          },
        });
      } catch (error) {
        const expired = error.code === 'messaging/registration-token-not-registered';
        if (!expired) throw error;
        await registrations.ref.child(device).remove();
      }
    }
  }
});
