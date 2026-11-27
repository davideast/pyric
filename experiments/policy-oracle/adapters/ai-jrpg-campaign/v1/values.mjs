import assert from 'node:assert/strict';

export function materialize(value,server,fixed) {
  if (Array.isArray(value)) return value.map(v=>materialize(v,server,fixed));
  if (value === null || typeof value !== 'object') return value;
  if (Object.hasOwn(value,'$server')) return server();
  if (Object.hasOwn(value,'$time')) return fixed(value.$time);
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,materialize(v,server,fixed)]));
}
export function fields(doc) {
  if (!doc) return null;
  function decode(v) {
    const [key] = Object.keys(v);
    switch (key) {
      case 'integerValue': return Number(v[key]);
      case 'timestampValue': return {$time:v[key]};
      case 'arrayValue': return (v[key].values ?? []).map(decode);
      case 'mapValue': return fields(v[key]);
      case 'nullValue': return null;
      case 'booleanValue': case 'stringValue': case 'doubleValue': return v[key];
      default: throw Error('Unexpected field type '+key);
    }
  }
  return Object.fromEntries(Object.entries(doc.fields ?? {}).map(([k,v])=>[k,decode(v)]));
}
export function matchesFilter(data,[field,op,value]) {
  assert.equal(op,'==');
  return field.split('.').reduce((current,part)=>current?.[part],data) === value;
}
export function raceResult(outcomes,actors,owner,uids) {
  const winners = actors.filter(role=>outcomes[role] === 'ALLOW');
  const denied = actors.filter(role=>outcomes[role] === 'DENY').length;
  return {allowed:winners.length,denied,ownerIsSoleWinner:winners.length === 1 && uids[winners[0]] === owner};
}
