export const securityIdentity = { uid: 'alice', token: { role: 'member', team: 'north' } };

export const flowRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    function signedIn() { return request.auth != null; }
    function ownsProject() { return request.auth.uid == resource.data.ownerId; }
    function canEdit() {
      return ownsProject() || request.auth.token.role == 'admin';
    }
    function validBudget() {
      return request.resource.data.budget >= 0 && request.resource.data.budget <= 5000;
    }
    function canPublish() {
      return request.resource.data.status != 'published' || request.auth.token.role == 'editor';
    }
    match /messages/{id} {
      allow read: if true;
      allow write: if request.resource.data.version >= 0;
    }
    match /projects/{id} {
      allow read: if signedIn();
      allow update: if signedIn() && canEdit() && validBudget() && canPublish()
        && request.resource.data.ownerId == resource.data.ownerId;
    }
  }
}`;

export interface ProjectDocument { title: string; ownerId: string; budget: number; status: string }
export interface SecurityScenario {
  id: string; label: string; description: string; path: string;
  project: ProjectDocument; proposed: ProjectDocument;
}
const project = { title: 'North launch', ownerId: 'alice', budget: 1200, status: 'draft' };
export const securityScenarios: readonly SecurityScenario[] = [
  {
    id: 'ownership', label: 'Edit another owner’s project', path: 'projects/bobs-launch',
    description: 'Alice changes the title of Bob’s project. Editing requires ownership or an admin role.',
    project: { ...project, ownerId: 'bob' }, proposed: { ...project, ownerId: 'bob', title: 'Renamed by Alice' },
  },
  {
    id: 'role', label: 'Publish without an editor role', path: 'projects/publishing',
    description: 'Alice owns this project, but publishing requires the editor role.',
    project, proposed: { ...project, status: 'published' },
  },
  {
    id: 'validation', label: 'Submit a negative budget', path: 'projects/budget',
    description: 'Alice owns this draft. Its budget must stay between 0 and 5,000.',
    project, proposed: { ...project, budget: -250 },
  },
  {
    id: 'allowed', label: 'Make an allowed edit', path: 'projects/allowed',
    description: 'Alice updates her draft’s budget to 1,500. All required conditions pass.',
    project, proposed: { ...project, budget: 1500 },
  },
];
