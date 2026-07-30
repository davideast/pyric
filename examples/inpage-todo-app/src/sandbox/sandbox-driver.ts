import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules, inspect as inspectFirestore, seedDocuments } from 'pyric/sandbox/firestore';
import { setRules as setRtdbRules, setData as setRtdbData } from 'pyric/sandbox/database';
import { getDatabase, ref, set, update } from 'pyric/database';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { sandbox as messagingSandbox } from 'pyric/messaging';

export interface RuleDenialRecord {
  method: string;
  path: string;
  auth?: { uid: string };
  rule?: { line?: number; expression?: string };
  reasons?: string[];
}

export interface InspectorSummary {
  currentUid: string | null;
  totalDocuments: number;
  collections: string[];
  totalEvents: number;
  recentDenials: RuleDenialRecord[];
  activeFirestoreRules: string;
  activeRtdbRulesJson: Record<string, unknown>;
}

export const STORAGE_RULES_SOURCE = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /attachments/{userId}/{fileName} {
      allow read: if true;
      allow write: if request.auth != null 
                   && request.auth.uid == userId
                   && request.resource.size < 5 * 1024 * 1024
                   && request.resource.contentType.matches('image/.*');
    }
  }
}`;

export class SandboxSimulationDriver {
  readonly sandbox: LocalSandbox;
  private currentAiScenario: 'success' | 'malformed' | 'quota_error' = 'success';
  private rtdbPresenceState: boolean = false;
  private activeFirestoreRulesSource: string = '';
  private activeRtdbRulesJson: Record<string, unknown> = {};

  constructor(projectId = 'inpage-task-workspace') {
    this.sandbox = initializeSandbox({ projectId });
  }

  initializeDefaultSecurityRules(): void {
    const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /todos/{todoId} {
      allow read: if true;
      allow create: if request.auth != null 
                    && request.resource.data.owner == request.auth.uid;
      allow update, delete: if request.auth != null 
                            && (resource.data.owner == request.auth.uid 
                                || request.auth.uid == 'bob@example.com'
                                || request.auth.uid == 'bob');
    }
  }
}`;
    this.activeFirestoreRulesSource = firestoreRules;
    setFirestoreRules(this.sandbox, firestoreRules);

    const rtdbRules = {
      rules: {
        presence: {
          ".read": true,
          "$uid": {
            ".write": "auth != null && auth.uid === $uid",
            ".validate": "newData.hasChildren(['state', 'lastSeen']) && newData.child('state').val() === 'online'"
          }
        },
        activity_stream: {
          ".read": true,
          "$event_id": {
            ".write": "auth != null",
            ".validate": "newData.hasChildren(['user', 'action', 'timestamp'])"
          }
        },
        shared_fanout: {
          ".read": true,
          ".write": "auth != null"
        }
      }
    };
    this.activeRtdbRulesJson = rtdbRules;
    setRtdbRules(this.sandbox, rtdbRules);
  }

  async seedDemoAccounts(): Promise<void> {
    const auth = getAuth(this.sandbox);
    await authSandbox.createUser(auth, {
      uid: 'alice',
      email: 'alice@example.com',
      password: 'password',
      displayName: 'Alice (Workspace Owner)',
    });
    await authSandbox.createUser(auth, {
      uid: 'bob',
      email: 'bob@example.com',
      password: 'password',
      displayName: 'Bob (Lead Collaborator)',
    });
    await authSandbox.createUser(auth, {
      uid: 'guest_demo',
      email: 'guest@example.com',
      password: 'guest12345',
      displayName: 'Guest Auditor',
    });

    seedDocuments(this.sandbox, {
      'todos/1': { title: 'Implement passkey authentication flow in auth provider', completed: false, category: 'Work', priority: 'High', ownerId: 'alice', createdAt: Date.now() - 3600000 },
      'todos/2': { title: 'Review shadcn monochromatic color contrast for WCAG AA', completed: true, category: 'Project', priority: 'High', ownerId: 'alice', createdAt: Date.now() - 7200000 },
      'todos/3': { title: 'Refactor Tailwind utility classes and CSS theme variables', completed: false, category: 'Work', priority: 'Medium', ownerId: 'alice', createdAt: Date.now() - 86400000 },
      'todos/4': { title: 'Write integration unit tests for database mutations', completed: false, category: 'Study', priority: 'Low', ownerId: 'alice', createdAt: Date.now() - 259200000 }
    });

    setRtdbData(this.sandbox, {
      presence: {
        'bob': { online: true, user: 'Bob (Collaborator)', lastSeen: Date.now() - 120000 },
        'charlie': { online: false, user: 'Charlie (Guest)', lastSeen: Date.now() - 3600000 }
      },
      activity_stream: {
        'init_1': { user: 'Bob (Collaborator)', action: 'Joined workspace & seeded RTDB presence tree', timestamp: Date.now() - 120000 }
      }
    });
  }

  getInspectorSummary(): InspectorSummary {
    const info = inspectFirestore(this.sandbox);
    const auth = getAuth(this.sandbox);
    const currentUser = auth.currentUser;
    const currentUid = currentUser ? (currentUser.displayName || currentUser.email || currentUser.uid) : 'null (Signed out)';

    const collections = info && info.documents && info.documents.byCollection ? Object.keys(info.documents.byCollection) : [];
    const totalDocuments = info && info.documents ? (info.documents.totalCount || 0) : 0;
    const totalEvents = info && info.events ? (info.events.totalCount || 0) : 0;
    const recentDenials = info && info.events && Array.isArray(info.events.recentDenials)
      ? info.events.recentDenials.map((d: any) => ({
          method: d.method || 'unknown',
          path: d.path || 'unknown',
          auth: d.auth,
          rule: d.rule,
          reasons: d.reasons,
        }))
      : [];

    return {
      currentUid,
      totalDocuments,
      collections,
      totalEvents,
      recentDenials,
      activeFirestoreRules: this.activeFirestoreRulesSource,
      activeRtdbRulesJson: this.activeRtdbRulesJson,
    };
  }

  logDenialDiagnosticToConsole(errorTitle = 'Security Rule Denial Detected'): void {
    const summary = this.getInspectorSummary();
    const denials = summary.recentDenials;
    if (denials.length === 0) {
      console.groupCollapsed(`🛡️ [Pyric Security Rule Diagnostic] ${errorTitle}`);
      console.warn('No recent rule denials recorded in sandbox inspection history.');
      console.warn('Current Auth Identity:', summary.currentUid);
      console.groupEnd();
      return;
    }
    const latest = denials[denials.length - 1];
    console.groupCollapsed(`🛡️ [Pyric Security Rule Denial Diagnostic] ${latest.method.toUpperCase()} ${latest.path}`);
    console.warn(`Method:       ${latest.method}`);
    console.warn(`Path:         ${latest.path}`);
    console.warn(`Auth UID:     ${latest.auth ? (latest.auth as any).uid || JSON.stringify(latest.auth) : 'null (Unauthenticated)'}`);
    if (latest.rule) {
      console.warn(`Rule Line:    ${latest.rule.line ?? 'Unknown'}`);
      console.warn(`Expression:   ${latest.rule.expression ?? 'N/A'}`);
    }
    if (latest.reasons && latest.reasons.length > 0) {
      console.warn(`Reasons:\n - ${latest.reasons.join('\n - ')}`);
    }
    console.groupEnd();
  }

  listOAuthTestUsers(): Array<{ uid: string; email?: string | null; displayName?: string | null }> {
    const auth = getAuth(this.sandbox);
    const allUsers = authSandbox.listUsers(auth);
    return allUsers.filter((u: any) => u.uid !== 'alice' && u.uid !== 'bob' && u.uid !== 'guest_demo');
  }

  async createOAuthTestUser(displayName: string, email: string, customUid?: string): Promise<string> {
    const auth = getAuth(this.sandbox);
    const uid = customUid && customUid.trim() ? customUid.trim() : `user_${Date.now()}`;
    await authSandbox.createUser(auth, {
      uid,
      email,
      displayName: displayName || email,
      password: 'oauth_dummy_password',
    });
    return uid;
  }

  async deleteOAuthTestUser(uid: string): Promise<void> {
    const auth = getAuth(this.sandbox);
    await authSandbox.deleteUser(auth, uid);
  }

  async togglePresence(): Promise<boolean> {
    const auth = getAuth(this.sandbox);
    const user = auth.currentUser;
    if (!user) throw new Error('Must be signed in to modify presence state.');

    this.rtdbPresenceState = !this.rtdbPresenceState;
    const rtdb = getDatabase(this.sandbox);
    const presenceRef = ref(rtdb, `presence/${user.uid}`);

    if (this.rtdbPresenceState) {
      await set(presenceRef, {
        state: 'online',
        lastSeen: Date.now(),
        displayName: user.displayName || user.email || user.uid,
      });
      await this.logActivity('Toggled presence to online');
    } else {
      await set(presenceRef, null);
      await this.logActivity('Toggled presence to offline');
    }
    return this.rtdbPresenceState;
  }

  async triggerAtomicFanOut(): Promise<void> {
    const auth = getAuth(this.sandbox);
    const user = auth.currentUser;
    if (!user) throw new Error('Must be signed in to execute atomic multi-path writes.');

    const rtdb = getDatabase(this.sandbox);
    const eventId = `evt_${Date.now()}`;
    const fanoutData: Record<string, unknown> = {
      [`shared_fanout/latest`]: { by: user.uid, timestamp: Date.now() },
      [`activity_stream/${eventId}`]: {
        user: user.displayName || user.email || user.uid,
        action: 'Executed atomic multi-path fan-out write',
        timestamp: Date.now(),
      },
    };
    await update(ref(rtdb), fanoutData);
  }

  async testRtdbRuleDenial(): Promise<void> {
    const auth = getAuth(this.sandbox);
    const user = auth.currentUser;
    const rtdb = getDatabase(this.sandbox);
    const presenceRef = ref(rtdb, `presence/${user ? user.uid : 'anon'}`);
    await set(presenceRef, {
      state: 'online',
      invalidField: 'Intentionally triggers declarative .validate failure',
    });
  }

  private async logActivity(action: string): Promise<void> {
    const auth = getAuth(this.sandbox);
    const user = auth.currentUser;
    if (!user) return;
    try {
      const rtdb = getDatabase(this.sandbox);
      const evtId = `evt_${Date.now()}`;
      await set(ref(rtdb, `activity_stream/${evtId}`), {
        user: user.displayName || user.email || user.uid,
        action,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn('Failed to record activity event to RTDB:', err);
    }
  }

  setAiScenario(scenario: 'success' | 'malformed' | 'quota_error'): void {
    this.currentAiScenario = scenario;
  }

  getAiScenario(): 'success' | 'malformed' | 'quota_error' {
    return this.currentAiScenario;
  }

  async deliverSimulatedPush(type: 'overdue' | 'update' | 'silent', messagingHandle: any): Promise<void> {
    let notification: { title?: string; body?: string } | undefined = undefined;
    let data: Record<string, string> = {};

    if (type === 'overdue') {
      notification = {
        title: '⏰ High Priority Task Overdue',
        body: 'Your onboarding milestone "Security Rule Audit" requires immediate review.',
      };
      data = { taskId: 'demo-task-1', priority: 'High' };
    } else if (type === 'update') {
      notification = {
        title: '🔄 Workspace Collaborator Update',
        body: 'Bob modified priority on 3 project tasks in your shared collection.',
      };
      data = { updatedBy: 'bob', action: 'bulk_edit' };
    } else if (type === 'silent') {
      data = {
        sync_type: 'background_cache_refresh',
        payload: '{"schema_version":"v2","timestamp":"' + Date.now() + '"}',
      };
    }

    await messagingSandbox.deliver(messagingHandle, {
      visibilityState: 'visible',
      notification,
      data,
    });
  }
}
