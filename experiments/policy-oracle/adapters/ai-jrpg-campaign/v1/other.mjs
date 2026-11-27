function step(id, actor, op, path, data, watch = [path]) {
  return {id, actor, op, path, watch, ...(data === undefined ? {} : {data})};
}

function conversations({uids, runId}) {
  const room = 'conversations/' + runId;
  const message = id => room + '/messages/' + id;
  const typing = role => room + '/typing/' + uids[role];
  const members = (...roles) => ({memberIds:roles.map(role => uids[role])});
  const text = (role, body = 'Hello from the oracle') => ({type:'text', senderId:uids[role], text:body});
  const image = {type:'image', senderId:uids.b, imagePath:'images/test.png'};
  const stamp = {updatedAt:{$server:true}};
  // Membership for child operations comes from the current parent document.
  const child = (id, actor, op, path, data) => step(id, actor, op, path, data, [room, path]);
  return [
    step('create-one-member', 'a', 'set', room + '-solo', members('a')),
    step('create-without-caller', 'a', 'set', room + '-excluded', members('b', 'c')),
    step('create-pair', 'a', 'set', room, members('a', 'b')),
    step('member-read', 'b', 'get', room),
    step('outsider-read', 'c', 'get', room),
    step('outsider-change-members', 'c', 'update', room, members('a', 'c')),
    child('member-text', 'b', 'set', message('first'), text('b')),
    child('member-read-message', 'b', 'get', message('first')),
    child('outsider-read-message', 'c', 'get', message('first')),
    child('outsider-text', 'c', 'set', message('outsider'), text('c')),
    child('sender-mismatch', 'b', 'set', message('wrong-sender'), text('a')),
    child('empty-text', 'b', 'set', message('empty'), text('b', '')),
    child('text-at-limit', 'b', 'set', message('at-limit'), text('b', 'x'.repeat(4000))),
    child('text-over-limit', 'b', 'set', message('over-limit'), text('b', 'x'.repeat(4001))),
    child('image-without-text', 'b', 'set', message('image'), image),
    child('image-empty-path', 'b', 'set', message('bad-image'), {...image, imagePath:''}),
    child('member-own-typing', 'b', 'set', typing('b'), stamp),
    child('member-change-others-typing', 'a', 'update', typing('b'), stamp),
    child('member-extra-typing-key', 'b', 'update', typing('b'), {...stamp, extra:true}),
    child('member-invalid-typing-time', 'b', 'update', typing('b'), {updatedAt:'now'}),
    child('outsider-own-typing', 'c', 'set', typing('c'), stamp),
    step('replace-member', 'a', 'update', room, members('a', 'c')),
    step('removed-read', 'b', 'get', room),
    step('added-read', 'c', 'get', room),
    child('removed-read-message', 'b', 'get', message('first')),
    child('added-read-message', 'c', 'get', message('first')),
    child('removed-text', 'b', 'set', message('removed'), text('b')),
    child('added-text', 'c', 'set', message('added'), text('c')),
    child('removed-own-typing', 'b', 'update', typing('b'), stamp),
    child('added-own-typing', 'c', 'set', typing('c'), stamp),
  ];
}

function sessions({emails, runId}) {
  const collection = 'pyric_sessions';
  const session = role => collection + '/' + runId + '-' + role;
  const watch = [session('a'), session('b')];
  const ownQuery = (id, actor, owner) => ({
    ...step(id, actor, 'query', collection, undefined, watch),
    filters:[['_savedBy.email', '==', emails[owner]]],
  });
  return [
    step('create-session-a', 'a', 'set', session('a'), {_savedBy:{email:emails.a}}),
    step('create-session-b', 'b', 'set', session('b'), {_savedBy:{email:emails.b}}),
    step('own-get', 'a', 'get', session('a')),
    step('other-get', 'a', 'get', session('b')),
    step('signed-out-get', 'out', 'get', session('a')),
    ownQuery('own-query-a', 'a', 'a'),
    ownQuery('own-query-b', 'b', 'b'),
    ownQuery('other-email-query', 'a', 'b'),
    {...step('unfiltered-mixed-owners', 'a', 'query', collection, undefined, watch), filters:[]},
  ];
}

function lobbies({uids, runId}) {
  const base = 'ttt_lobbies/' + runId;
  const cancel = base + '-cancel', play = base + '-play';
  const open = {host:uids.a, status:'open'};
  const cancelled = {status:'cancelled'}, join = {guest:uids.b};
  const start = {status:'playing', gameId:runId + '-game'};
  return [
    step('create-wrong-host', 'b', 'set', base + '-wrong-host', open),
    step('create-with-guest', 'a', 'set', base + '-guest', {...open, ...join}),
    step('create-with-game', 'a', 'set', base + '-game', {...open, gameId:start.gameId}),
    step('create-to-cancel', 'a', 'set', cancel, open),
    step('nonhost-cancel', 'b', 'update', cancel, cancelled),
    step('cancel-extra-field', 'a', 'update', cancel, {...cancelled, note:'closing'}),
    step('host-cancel', 'a', 'update', cancel, cancelled),
    step('join-cancelled', 'b', 'update', cancel, join),
    step('create-to-play', 'a', 'set', play, open),
    step('host-start-without-guest', 'a', 'update', play, start),
    step('host-join', 'a', 'update', play, {guest:uids.a}),
    step('join-extra-field', 'b', 'update', play, {...join, note:'joining'}),
    step('guest-join', 'b', 'update', play, join),
    step('second-join', 'c', 'update', play, {guest:uids.c}),
    step('guest-start', 'b', 'update', play, start),
    step('start-extra-field', 'a', 'update', play, {...start, note:'starting'}),
    step('host-start', 'a', 'update', play, start),
    step('cancel-playing', 'a', 'update', play, cancelled),
  ];
}

export const families = {
  'conversation-membership': conversations,
  'session-access': sessions,
  'lobby-transitions': lobbies,
};

// Each mutation tightens one allowed operation while preserving the setup sequence.
export function mutate(family, source, variant) {
  let from, to;
  switch (family) {
    case 'conversation-membership':
      from = '&& request.auth.uid in resource.data.memberIds;';
      to = '&& request.auth.uid == resource.data.memberIds[0];';
      // The same membership expression occurs on updates. Change only the read rule.
      from = 'allow read: if request.auth != null\n                  ' + from;
      to = 'allow read: if request.auth != null\n                  ' + to;
      break;
    case 'session-access':
      from = 'allow get, list: if request.auth != null';
      to = 'allow list: if request.auth != null';
      break;
    case 'lobby-transitions':
      from = "affectedKeys().hasOnly(['status', 'gameId'])";
      to = "affectedKeys().hasOnly(['status'])";
      break;
    default: throw new Error('Unknown campaign family: ' + family);
  }
  if (source.split(from).length !== 2) throw new Error('Mutation source changed: ' + variant + '/' + family);
  return source.replace(from, to);
}
