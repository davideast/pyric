export const accounts = ['writer','reader'];
export function fixture(pid) {
  const cycle = 7, name = 'Oracle farmer';
  const paths = {contribution:'hearthfest/7/contributions/' + pid, award:'hearthfest/7/awards/' + pid};
  const contribution = {pid,name,items:{pumpkin:2,iron:2}};
  const award = {pid,name,cycle,tier:'ember',points:10,benefit:{label:'a bundle of turnip seeds (6)',gold:0,
    items:{'turnip-seeds':6}},attended:false,granted:false,ts:1793491200000};
  return {paths,contribution,attempts:[
    {id:'signed-out-create',actor:'signed-out',method:'create',data:award},
    {id:'signed-create',actor:'writer',method:'create',data:award},
    {id:'signed-update-points',actor:'writer',method:'update',data:{points:11}},
    {id:'signed-delete',actor:'writer',method:'delete',data:null},
  ]};
}
