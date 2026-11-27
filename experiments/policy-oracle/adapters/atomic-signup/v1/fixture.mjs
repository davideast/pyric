import {fixture} from '../../invite-profile/v1/fixture.mjs';

export const accounts = ['claimant', 'reader'];

export function signup(caller, runId) {
  const {paths, steps} = fixture({claimant:caller}, runId);
  const write = step => ({method:step.method, path:paths[step.target], data:step.data});
  const claim = write(steps.find(step => step.id === 'first-claim'));
  const profile = write(steps.find(step => step.id === 'claimant-profile'));
  return {paths:{invite:claim.path, profile:profile.path}, attempts:[
    {id:'atomic-signup', method:'writeBatch.commit', writes:[claim, profile]},
    {id:'sequential-claim', method:'updateDoc', writes:[claim]},
    {id:'sequential-profile', method:'setDoc', writes:[profile]},
  ]};
}
