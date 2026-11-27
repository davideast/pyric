import {fixture as awardFixture} from '../../hearthfest-award/v1/fixture.mjs';
export {accounts} from '../../hearthfest-award/v1/fixture.mjs';

export function fixture(pid) {
  const {paths,contribution,attempts} = awardFixture(pid);
  const award = attempts.find(attempt=>attempt.id === 'signed-create').data;
  return {paths, initial:{contribution,award}, attempts:[10,11].map(points=>({
    id:'batch-'+points, method:'writeBatch.commit', writes:[
      {path:paths.contribution,data:{items:{...contribution.items,pumpkin:contribution.items.pumpkin+1}}},
      {path:paths.award,data:{points,ts:award.ts+1}}
    ]
  }))};
}
