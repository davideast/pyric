export const project = 'digame-mas';
export const number = '803835021738';
export const revision = 'b3bed5e36acaa7bfc47a600e86e015fb84b1ac70';
export const probePath = 'suites/ai-jrpg/storage/claims/clip-access/v1/probes/clip-objects/v1';
export const closed = "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { match /{path=**} { allow read, write: if false; } } }\n";
export const control = "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { match /clips/{clip} { allow read, write: if request.auth != null; } } }\n";
export const marker = 'clips/propagation.wav';
export const transport = 'clips/transport.wav';
export const seed = {path:'clips/clip.wav',size:256,mime:'audio/wav',salt:1};
export const max = 2 * 1024 * 1024;
export const cases = [
  {id:'signed-wav-create',actor:'signed',op:'upload',path:'clips/new.wav',size:256,mime:'audio/wav',salt:1},
  {id:'signed-read',actor:'signed',op:'read',path:'clips/clip.wav'},
  {id:'signed-out-read',actor:'out',op:'read',path:'clips/clip.wav'},
  {id:'signed-out-write',actor:'out',op:'upload',path:'clips/clip.wav',size:256,mime:'audio/wav',salt:2},
  {id:'wrong-mime',actor:'signed',op:'upload',path:'clips/clip.wav',size:256,mime:'audio/mpeg',salt:1},
  {id:'signed-overwrite',actor:'signed',op:'upload',path:'clips/clip.wav',size:256,mime:'audio/wav',salt:2},
  {id:'signed-delete',actor:'signed',op:'delete',path:'clips/clip.wav'},
  {id:'limit-minus-one',actor:'signed',op:'upload',path:'clips/below.wav',size:max-1,mime:'audio/wav',salt:3},
  {id:'limit-equal',actor:'signed',op:'upload',path:'clips/equal.wav',size:max,mime:'audio/wav',salt:3},
  {id:'limit-plus-one',actor:'signed',op:'upload',path:'clips/above.wav',size:max+1,mime:'audio/wav',salt:3},
  {id:'outside-prefix',actor:'signed',op:'upload',path:'other/clip.wav',size:256,mime:'audio/wav',salt:1}
];

export function bucketFor(runId) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(runId)) throw Error('invalid run id');
  return project+'-jrpg-clips-'+runId.replaceAll('-','');
}
export function bytes(size,salt) {
  const data = Buffer.alloc(size,salt);
  // Use an actual PCM header in both MIME controls. The size limit is over stored bytes.
  data.write('RIFF',0); data.writeUInt32LE(size-8,4); data.write('WAVEfmt ',8);
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
  data.writeUInt32LE(8000,24); data.writeUInt32LE(8000,28); data.writeUInt16LE(1,32);
  data.writeUInt16LE(8,34); data.write('data',36); data.writeUInt32LE(size-44,40);
  return data;
}
