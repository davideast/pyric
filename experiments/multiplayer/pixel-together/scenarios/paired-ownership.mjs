import { transitionClaim } from '../architecture/paired-claims.mjs';

export const pairedAssertions = {
  'paired-user-race': ['one user acquires only one color', 'loser reads current member claim', 'paired records agree'],
  'paired-color-race': ['one color has only one owner', 'losing member remains unassigned'],
  'paired-rules': ['color-only acquisition denied', 'member-only acquisition denied', 'mismatched generation denied', 'forged owner denied', 'two colors in one batch denied', 'signed out denied', 'outsider denied', 'direct valid pair accepted', 'acquire and draw in same batch accepted', 'switch without releasing old color denied', 'switch without acquiring new color denied', 'color-only release denied', 'member-only release denied', 'color deletion denied', 'member deletion denied', 'extra field denied', 'release and draw in same batch denied', 'denials preserve pair'],
  'paired-lifecycle': ['occupied switch refuses', 'occupied switch preserves current color', 'release clears both records', 'switch updates all three records', 'reacquisition increments generation', 'fresh drawing accepted', 'stale drawing denied', 'stale transaction release refuses', 'stale direct release denied', 'stale operations preserve current pair'],
};
const root = 'pairedBoards/main';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const bounded = async promise => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Paired schedule timeout')), 5000); })]); }
  finally { clearTimeout(timer); }
};
const settle = promise => promise.then(value => ({ value }), error => ({ error }));

export async function runPairedOwnership({ sdk, backend, runCase, operation, assert, record }) {
  const setup = async caseId => {
    const db = await backend();
    const reads = [];
    const get = path => operation(caseId, 'alice', 'get', `${root}/${path}`, async () => (await sdk.getDoc(sdk.doc(db('alice'), `${root}/${path}`))).data());
    const transition = (uid, expected, nextColor, afterRead) => operation(caseId, uid, 'transaction', root, () => transitionClaim(sdk, db(uid), {
      board: 'main', uid, expected, nextColor, afterRead,
      read: async (path, action) => {
        const value = await operation(caseId, uid, 'transaction-read', path, async () => (await action()).data());
        reads.push({ uid, path, value }); return value;
      },
      stage: (path, value) => record('operations', { caseId, actor: uid, path, kind: 'transaction-stage-set', status: 'staged', value }),
    }));
    const batch = (uid, entries) => operation(caseId, uid, 'batch', root, async () => {
      const writes = sdk.writeBatch(db(uid));
      for (const [path, data] of entries) {
        record('operations', { caseId, actor: uid, path: `${root}/${path}`, kind: data === null ? 'batch-stage-delete' : 'batch-stage-set', status: 'staged', value: data });
        const ref = sdk.doc(db(uid), `${root}/${path}`);
        if (data === null) writes.delete(ref); else writes.set(ref, data);
      }
      await writes.commit();
    });
    const deny = async (name, action) => {
      const outcome = await settle(action());
      assert(caseId, name, 'permission-denied', outcome.error?.code ?? 'acknowledged');
    };
    return { db, reads, get, transition, batch, deny };
  };
  for (const sameUser of [true, false]) {
    const caseId = sameUser ? 'paired-user-race' : 'paired-color-race';
    await runCase(caseId, async () => {
      const s = await setup(caseId);
      const loserUid = sameUser ? 'alice' : 'bob';
      const ready = deferred(), release = deferred(); let first = true;
      const pending = settle(s.transition(loserUid, null, sameUser ? 'blue' : 'red', async () => {
        if (first) { first = false; ready.resolve(); await bounded(release.promise); }
      }));
      let winner;
      try { await bounded(ready.promise); winner = await s.transition('alice', null, 'red'); }
      finally { release.resolve(); }
      const loser = await bounded(pending); if (loser.error) throw loser.error;
      assert(caseId, sameUser ? 'one user acquires only one color' : 'one color has only one owner', [{ color: 'red', epoch: 1 }, false], [winner, loser.value]);
      if (sameUser) {
        assert(caseId, 'loser reads current member claim', { color: 'red', epoch: 1 }, s.reads.filter(r => r.path.endsWith('/memberClaims/alice')).at(-1).value);
        assert(caseId, 'paired records agree', [{ color: 'red', epoch: 1 }, { uid: 'alice', epoch: 1 }, { uid: null, epoch: 0 }], await Promise.all(['memberClaims/alice', 'colorClaims/red', 'colorClaims/blue'].map(s.get)));
      } else assert(caseId, 'losing member remains unassigned', { color: null, epoch: 0 }, await s.get('memberClaims/bob'));
    });
  }
  await runCase('paired-rules', async () => {
    const s = await setup('paired-rules');
    const member = ['memberClaims/alice', { color: 'red', epoch: 1 }];
    const color = ['colorClaims/red', { uid: 'alice', epoch: 1 }];
    await s.deny('color-only acquisition denied', () => s.batch('alice', [color]));
    await s.deny('member-only acquisition denied', () => s.batch('alice', [member]));
    await s.deny('mismatched generation denied', () => s.batch('alice', [member, ['colorClaims/red', { uid: 'alice', epoch: 2 }]]));
    await s.deny('forged owner denied', () => s.batch('alice', [member, ['colorClaims/red', { uid: 'bob', epoch: 1 }]]));
    await s.deny('two colors in one batch denied', () => s.batch('alice', [member, color, ['colorClaims/blue', { uid: 'alice', epoch: 1 }]]));
    await s.deny('signed out denied', () => s.batch(null, [member, color]));
    await s.deny('outsider denied', () => s.batch('outsider', [member, color]));
    await s.batch('alice', [member, color, ['pixels/0', { color: 'red', epoch: 1 }]]);
    assert('paired-rules', 'acquire and draw in same batch accepted', { color: 'red', epoch: 1 }, await s.get('pixels/0'));
    assert('paired-rules', 'direct valid pair accepted', [{ color: 'red', epoch: 1 }, { uid: 'alice', epoch: 1 }], await Promise.all(['memberClaims/alice', 'colorClaims/red'].map(s.get)));
    await s.deny('switch without releasing old color denied', () => s.batch('alice', [['memberClaims/alice', { color: 'blue', epoch: 1 }], ['colorClaims/blue', { uid: 'alice', epoch: 1 }]]));
    await s.deny('switch without acquiring new color denied', () => s.batch('alice', [['memberClaims/alice', { color: 'blue', epoch: 1 }], ['colorClaims/red', { uid: null, epoch: 1 }]]));
    await s.deny('color-only release denied', () => s.batch('alice', [['colorClaims/red', { uid: null, epoch: 1 }]]));
    await s.deny('member-only release denied', () => s.batch('alice', [['memberClaims/alice', { color: null, epoch: 0 }]]));
    await s.deny('color deletion denied', () => s.batch('alice', [['colorClaims/red', null]]));
    await s.deny('member deletion denied', () => s.batch('alice', [['memberClaims/alice', null]]));
    await s.deny('extra field denied', () => s.batch('alice', [['memberClaims/alice', { color: null, epoch: 0, extra: true }], ['colorClaims/red', { uid: null, epoch: 1 }]]));
    await s.deny('release and draw in same batch denied', () => s.batch('alice', [['memberClaims/alice', { color: null, epoch: 0 }], ['colorClaims/red', { uid: null, epoch: 1 }], ['pixels/0', { color: 'red', epoch: 1 }]]));
    assert('paired-rules', 'denials preserve pair', [{ color: 'red', epoch: 1 }, { uid: 'alice', epoch: 1 }, { uid: null, epoch: 0 }], await Promise.all(['memberClaims/alice', 'colorClaims/red', 'colorClaims/blue'].map(s.get)));
  });
  await runCase('paired-lifecycle', async () => {
    const s = await setup('paired-lifecycle');
    const red = await s.transition('alice', null, 'red');
    const blue = await s.transition('bob', null, 'blue');
    assert('paired-lifecycle', 'occupied switch refuses', false, await s.transition('alice', red, 'blue'));
    assert('paired-lifecycle', 'occupied switch preserves current color', [{ color: 'red', epoch: 1 }, { uid: 'alice', epoch: 1 }], await Promise.all(['memberClaims/alice', 'colorClaims/red'].map(s.get)));
    await s.transition('bob', blue, null);
    assert('paired-lifecycle', 'release clears both records', [{ color: null, epoch: 0 }, { uid: null, epoch: 1 }], await Promise.all(['memberClaims/bob', 'colorClaims/blue'].map(s.get)));
    const switched = await s.transition('alice', red, 'blue');
    assert('paired-lifecycle', 'switch updates all three records', [{ color: 'blue', epoch: 2 }, { uid: null, epoch: 1 }, { uid: 'alice', epoch: 2 }], await Promise.all(['memberClaims/alice', 'colorClaims/red', 'colorClaims/blue'].map(s.get)));
    await s.transition('alice', switched, null);
    const current = await s.transition('alice', null, 'blue');
    assert('paired-lifecycle', 'reacquisition increments generation', { color: 'blue', epoch: 3 }, current);
    await s.batch('alice', [['pixels/0', current]]);
    assert('paired-lifecycle', 'fresh drawing accepted', { color: 'blue', epoch: 3 }, await s.get('pixels/0'));
    await s.deny('stale drawing denied', () => s.batch('alice', [['pixels/0', switched]]));
    assert('paired-lifecycle', 'stale transaction release refuses', false, await s.transition('alice', switched, null));
    await s.deny('stale direct release denied', () => s.batch('alice', [['memberClaims/alice', { color: null, epoch: 0 }], ['colorClaims/blue', { uid: null, epoch: 2 }]]));
    assert('paired-lifecycle', 'stale operations preserve current pair', [{ color: 'blue', epoch: 3 }, { uid: 'alice', epoch: 3 }, { color: 'blue', epoch: 3 }], await Promise.all(['memberClaims/alice', 'colorClaims/blue', 'pixels/0'].map(s.get)));
  });
}
