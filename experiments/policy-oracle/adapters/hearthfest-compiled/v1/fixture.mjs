import {fixture as stock} from '../../hearthfest-award/v1/fixture.mjs';
export {accounts} from '../../hearthfest-award/v1/fixture.mjs';
export function fixture(pid) {
  const plan = stock(pid);
  const [signedOut,create,update,del] = plan.attempts;
  return {...plan, attempts:[
    signedOut,
    {...create,id:'signed-create-11',data:{...create.data,points:11}},
    create,update,
    {...update,id:'signed-update-tier',data:{tier:'hearthfriend'}},
    {...update,id:'signed-update-benefit',data:{benefit:null}},
    {...update,id:'signed-update-valid',data:{points:10,granted:true}},
    del
  ]};
}
