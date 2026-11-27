export const sourcePath = 'suites/ai-jrpg/pixelwood/claims/world-role/v1/probes/app-and-mirror/v1/app.rules';
export const sourceDigest = '7caa3834574676c501f781e15705eb95dfc3be14a6f9c8791a4177817303df2d';
export const revision = 'b3bed5e36acaa7bfc47a600e86e015fb84b1ac70';
export const accounts = ['claimant', 'other', 'guest', 'reader'];
export const stamp = '$serverTimestamp';
export const seedTime = '2026-01-01T00:00:00Z';
export function fixture(uids, runId) {
  const code = 'oracle-' + runId;
  const paths = {invite: 'invites/' + code};
  for (const role of ['claimant','other','guest']) paths[role] = 'players/' + uids[role];
  const claim = {usedBy: uids.claimant, usedAt: stamp};
  const named = {name: 'Oracle player', createdAt: stamp, inviteCode: code};
  const guest = {skills: {lockpicking: 1}, rep: 0, updatedAt: stamp};
  const steps = [
    {id:'first-claim', role:'claimant', target:'invite', method:'update', data:claim},
    {id:'repeat-claim', role:'claimant', target:'invite', method:'update', data:claim},
    {id:'claimant-profile', role:'claimant', target:'claimant', method:'create', data:named},
    {id:'other-profile', role:'other', target:'other', method:'create', data:named},
    {id:'guest-profile', role:'guest', target:'guest', method:'create', data:guest},
  ];
  return {code, paths, steps};
}
export const materialize = (data, timestamp) => Object.fromEntries(Object.entries(data).map(([k,v]) => [k, v === stamp ? timestamp : v]));
