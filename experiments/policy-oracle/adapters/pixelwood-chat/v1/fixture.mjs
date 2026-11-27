export const accounts = ['sender','reader'];
export const attempts = [
  {id:'no-profile', profile:'none', fresh:true},
  {id:'mechanics-only', profile:'mechanics', fresh:true},
  {id:'named-profile', profile:'named', fresh:true},
  {id:'rapid-repeat', profile:'named', fresh:false},
  {id:'after-cooldown', profile:'named', fresh:false},
];
export function profileData(kind) {
  if (kind === 'none') return null;
  if (kind === 'mechanics') return {skills:{lockpicking:1},rep:0};
  if (kind === 'named') return {name:'Oracle player'};
  throw Error('Unknown profile');
}
export function messageData(uid, kind, t) {
  return {uid, name:kind === 'named' ? 'Oracle player' : 'wanderer-' + uid.slice(-4),
    zone:'village', scope:'global', tx:2, ty:3, text:'Hello from the village', t};
}
export function pathsFor(uid,runId,id) {
  return {ledger:'chatMeta/' + uid, message:'chat/oracle-' + runId + '-' + id, profile:'players/' + uid};
}
