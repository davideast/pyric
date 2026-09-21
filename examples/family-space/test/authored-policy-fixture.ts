export const noteSource = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
service cloud.firestore { match /databases/{database}/documents {
match /families/{family}/apps/{app}/records/{record} {
 function member() { return isAuthenticated() && exists(/databases/$(database)/documents/families/$(family)/members/$(request.auth.uid)); }
 allow read: if member();
 allow create: if member() && exists(/databases/$(database)/documents/families/$(family)/members/$(request.resource.data.recipient)) && request.resource.data.owner == request.auth.uid && request.resource.data.text is string;
 allow update: if member() && resource.data.owner == request.auth.uid && request.resource.data.owner == resource.data.owner && request.resource.data.text is string;
 allow delete: if member() && resource.data.owner == request.auth.uid;
}}}`;
export const note = { owner: 'sam', text: 'Hello', recipient: 'zoe' };
export const noteCases = [
 {description:'owner creates',method:'create',uid:'sam',after:note,expectation:'ALLOW'},
 {description:'forged owner',method:'create',uid:'zoe',after:note,expectation:'DENY'},
 {description:'owner edits',method:'update',uid:'sam',before:note,after:{...note,text:'Updated'},expectation:'ALLOW'},
 {description:'other kid cannot edit',method:'update',uid:'zoe',before:note,after:{...note,text:'Updated'},expectation:'DENY'},
 {description:'owner deletes',method:'delete',uid:'sam',before:note,expectation:'ALLOW'},
 {description:'other kid cannot delete',method:'delete',uid:'zoe',before:note,expectation:'DENY'},
];
