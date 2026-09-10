import type { EvalTask } from '../types.js';

const task: EvalTask = {
  id: 'sign-in-a-guest-and-write-their-draft',
  prompt:
    'A visitor should be able to try the editor without an account. Sign the app in as a guest and save a draft at drafts/first for whoever that turns out to be.',
  seed: {
    firestore: { 'drafts/seeded': { title: 'welcome' } },
  },
  acceptedFirstOperations: ['signin_auth_anonymous'],
  assert: (state) => {
    const signedIn = state.calls.find(
      (call) => call.operation === 'signin_auth_anonymous' && call.ok,
    );
    if (!signedIn) return 'nobody was signed in anonymously';
    const session = (signedIn.data as { appSession?: { uid?: string; isAnonymous?: boolean } })
      ?.appSession;
    if (session?.isAnonymous !== true) return 'the app session is not an anonymous one';
    const minted = session.uid;
    if (typeof minted !== 'string') return 'the anonymous session carries no uid';
    // An anonymous identity has no address, so it is not part of the state
    // file a fixture round-trips; the pool is read through the listing call.
    const listed = state.calls.find((call) => call.operation === 'list_auth_users' && call.ok);
    if (!listed) return 'the pool was never listed';
    const pool = (listed.data as { users?: Array<{ uid: string; isAnonymous: boolean }> })?.users;
    if (!pool?.some((user) => user.uid === minted && user.isAnonymous)) {
      return 'the anonymous user is not in the pool';
    }
    const draft = state.firestore.get('drafts/first');
    if (draft === null) return 'the draft was never written';
    return true;
  },
  tags: ['auth', 'identity', 'multi-step'],
};

export default task;
