const config = 'world/config';
const arc = 'world/arc';
const stamp = {$server:true};

function write(id,actor,op,path,data,watch = [path]) {
  return {id,actor,op,path,...(data === undefined ? {} : {data}),watch};
}

function worldAdmin({uids}) {
  const watch = [config,arc];
  const setAdmins = (id,actor,op,admins) => write(id,actor,op,config,{admins},watch);
  // The same client payload changes the stored timestamp on each successful call.
  const protectedWrite = id => write(id,'b','set',arc,{chapter:1,updatedAt:stamp},watch);
  return [
    protectedWrite('arc-open'),
    setAdmins('bootstrap-excludes-caller','a','set',[uids.b]),
    setAdmins('bootstrap-includes-caller','a','set',[uids.a]),
    protectedWrite('arc-after-bootstrap'),
    setAdmins('unlisted-self-add','b','update',[uids.a,uids.b]),
    setAdmins('admin-adds-peer','a','update',[uids.a,uids.b]),
    protectedWrite('arc-after-add'),
    setAdmins('admin-removes-peer','a','update',[uids.a]),
    protectedWrite('arc-after-remove')
  ];
}

function unusedInvite(uid) {
  return {createdBy:uid,createdAt:stamp,usedBy:null,usedAt:null};
}

function inviteContention({uids,runId}) {
  return [1,2,3].flatMap(round => {
    const path = 'invites/race-'+runId+'-'+round;
    return [
      write('mint-'+round,'c','set',path,unusedInvite(uids.c)),
      {id:'race-'+round,op:'race',path,actors:['a','b'],dataByActor:{
        a:{usedBy:uids.a,usedAt:stamp},b:{usedBy:uids.b,usedAt:stamp}
      },watch:[path]}
    ];
  });
}

function profileLifecycle({uids,runId}) {
  const code = 'name-'+runId, invite = 'invites/'+code, profile = 'players/'+uids.b;
  const watch = [invite,profile];
  const create = id => write(id,'b','set',profile,{name:'Rowan',inviteCode:code,createdAt:stamp},watch);
  return [
    write('mint-unused','a','set',invite,unusedInvite(uids.a),watch),
    create('named-before-claim'),
    write('claim-for-self','b','update',invite,{usedBy:uids.b,usedAt:stamp},watch),
    create('named-after-claim'),
    write('rename-owner','b','update',profile,{name:'Juniper'},watch),
    write('rename-other','c','update',profile,{name:'Alder'},watch)
  ];
}

function combatCreate({uids}) {
  const owner = 'players/'+uids.b, peer = 'players/'+uids.c, watch = [config,owner,peer];
  // Both probes use B and the same payload. The signed-in bootstrap admin clears
  // the two paths before the next pair, so all six probes are creates.
  const pair = stage => [
    write(stage+'-owner-create','b','set',owner,{combat:{hp:9}},watch),
    write(stage+'-peer-create','b','set',peer,{combat:{hp:9}},watch)
  ];
  const clear = stage => [
    write(stage+'-clear-owner','a','delete',owner,undefined,watch),
    write(stage+'-clear-peer','a','delete',peer,undefined,watch)
  ];
  return [
    ...pair('open'),...clear('open'),
    write('bootstrap','a','set',config,{admins:[uids.a]},watch),
    ...pair('unlisted'),...clear('unlisted'),
    write('list-caller','a','update',config,{admins:[uids.a,uids.b]},watch),
    ...pair('listed')
  ];
}

function tradeLedger({uids,runId}) {
  const path = 'trades/trade-'+runId, watch = [config,path];
  const receipt = {uid:uids.b,npc:'smith',side:'buy',item:'iron',qty:1,unit:4,gold:4,t:stamp};
  return [
    write('bootstrap-admin','a','set',config,{admins:[uids.a]},watch),
    write('create-other-uid','b','set',path,{...receipt,uid:uids.c},watch),
    write('create-stale-time','b','set',path,{...receipt,t:{$time:'2020-01-01T00:00:00.000Z'}},watch),
    write('create-own-server-time','b','set',path,receipt,watch),
    write('owner-edit','b','update',path,{qty:2},watch),
    write('admin-edit','a','update',path,{qty:2},watch),
    write('owner-delete','b','delete',path,undefined,watch),
    write('admin-delete','a','delete',path,undefined,watch)
  ];
}

function oneTimeClaim(collection,{uids,runId}) {
  const path = key => collection+'/'+runId+'-'+key+'/players/'+uids.a;
  const first = path('first'), next = path('next'), watch = [first,next];
  const claim = {claimedAt:stamp};
  return [
    write('non-owner-unused','b','set',first,claim,watch),
    write('owner-first','a','set',first,claim,watch),
    write('owner-repeat','a','set',first,claim,watch),
    write('owner-delete','a','delete',first,undefined,watch),
    write('owner-fresh-key','a','set',next,claim,watch)
  ];
}

function eventLedger({uids,runId}) {
  const path = id => 'events/'+runId+'-'+id;
  const add = (id,writer,actor) => write(id,writer,'set',path(id),
    {kind:'caught',actor:uids[actor],zone:'cave',detail:'test',ts:stamp,cycle:7},[config,path(id)]);
  const first = path('open-self');
  return [
    add('open-self','b','b'),
    add('open-other','b','c'),
    write('bootstrap-admin','a','set',config,{admins:[uids.a]},[config,first]),
    add('configured-self','b','b'),
    add('configured-other','b','c'),
    add('admin-self','a','a'),
    add('admin-other','a','c'),
    write('owner-edit','b','update',first,{detail:'revised'},[config,first]),
    write('admin-edit','a','update',first,{detail:'revised'},[config,first])
  ];
}

export const families = {
  'world-admin-lifecycle':worldAdmin,
  'invite-contention':inviteContention,
  'profile-lifecycle':profileLifecycle,
  'combat-profile-create':combatCreate,
  'trade-ledger':tradeLedger,
  'chest-claim':ctx=>oneTimeClaim('chestClaims',ctx),
  'house-claim':ctx=>oneTimeClaim('houseClaims',ctx),
  'event-ledger':eventLedger
};

// Each mutation changes one clause in the matching collection, leaving the rest
// of the full upstream ruleset intact. Recheck the anchors when the source moves.
export function mutate(family,source,variant) {
  const guestFields = variant === 'deploy' ? "['skills', 'rep', 'updatedAt']" : "['skills', 'rep', 'combat', 'updatedAt']";
  const otherGuestFields = variant === 'deploy' ? "['skills', 'rep', 'combat', 'updatedAt']" : "['skills', 'rep', 'updatedAt']";
  const mutations = {
    'world-admin-lifecycle':['world/config','allow update: if isAdmin();','allow update: if request.auth != null;'],
    'invite-contention':['invites/{code}','&& resource.data.usedBy == null','&& true'],
    'profile-lifecycle':['players/{uid}',"affectedKeys().hasOnly(['name', 'skills'","affectedKeys().hasOnly(['skills'"],
    'combat-profile-create':['players/{uid}','request.resource.data.keys().hasOnly('+guestFields+')','request.resource.data.keys().hasOnly('+otherGuestFields+')'],
    'trade-ledger':['trades/{id}','request.resource.data.t == request.time','request.resource.data.t is timestamp'],
    'chest-claim':['chestClaims/{key}/players/{uid}','allow create:','allow create, update:'],
    'house-claim':['houseClaims/{key}/players/{uid}','allow create:','allow create, update:'],
    'event-ledger':['events/{id}','(request.resource.data.actor == request.auth.uid || adminOrOpen())','(request.resource.data.actor == request.auth.uid)']
  };
  const [path,clause,changed] = mutations[family];
  const header = '    match /'+path+' {';
  if (source.split(header).length !== 2) throw Error('Expected one match block for '+path);
  const start = source.indexOf(header);
  const end = source.indexOf('\n    }',start);
  const block = source.slice(start,end);
  if (end < 0 || block.split(clause).length !== 2) throw Error('Expected one mutation site for '+family);
  return source.slice(0,start)+block.replace(clause,changed)+source.slice(end);
}
