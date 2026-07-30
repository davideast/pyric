import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { TaskApplicationService, type TaskItem, type ActivityEvent } from '../services/firebase-service';
import { SandboxSimulationDriver } from '../sandbox/sandbox-driver';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import type { OAuthUserItem } from '../components/OAuthPopupModal';

interface WorkspaceContextValue {
  appService: TaskApplicationService;
  sandboxDriver: SandboxSimulationDriver;
  currentUser: any | null;
  fcmToken: string | null;
  requestPushToken: () => Promise<string>;
  revokePushToken: () => void;
  oauthModalOpen: boolean;
  oauthUsers: OAuthUserItem[];
  selectOAuthUser: (uid: string) => void;
  createOAuthUser: (name: string, email: string, customUid?: string) => Promise<void>;
  deleteOAuthUser: (uid: string) => void;
  cancelOAuthPopup: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const WorkspaceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initRef = useRef<boolean>(false);
  const [driver] = useState(() => new SandboxSimulationDriver('inpage-task-workspace'));
  const [service] = useState(() => new TaskApplicationService(driver.sandbox));
  const [currentUser, setCurrentUser] = useState<any | null>(null);
  const [fcmToken, setFcmToken] = useState<string | null>(null);
  const [oauthModalOpen, setOauthModalOpen] = useState(false);
  const [oauthUsers, setOauthUsers] = useState<OAuthUserItem[]>([]);
  const oauthPromiseRef = useRef<{ resolve: (val: any) => void; reject: (err: any) => void } | null>(null);

  useEffect(() => {
    driver.setOAuthPopupHandler(() => {
      const auth = getAuth(driver.sandbox);
      const users = authSandbox.listUsers(auth).map((u: any) => ({
        uid: u.uid,
        email: u.email || null,
        displayName: u.displayName || null,
      }));
      setOauthUsers(users);
      setOauthModalOpen(true);
      return new Promise<any>((resolve, reject) => {
        oauthPromiseRef.current = { resolve, reject };
      });
    });
  }, [driver]);

  const selectOAuthUser = (uid: string) => {
    const auth = getAuth(driver.sandbox);
    const users = authSandbox.listUsers(auth);
    const found = users.find((u: any) => u.uid === uid);
    if (!found) return;
    setOauthModalOpen(false);
    if (oauthPromiseRef.current) {
      oauthPromiseRef.current.resolve({
        user: {
          uid: found.uid,
          email: found.email || `${found.uid}@example.com`,
          displayName: found.displayName || found.uid,
          isAnonymous: false,
          getIdToken: async () => `fake-${found.uid}`,
          getIdTokenResult: async () => ({
            token: `fake-${found.uid}`,
            claims: { sub: found.uid },
            expirationTime: new Date().toISOString(),
            issuedAtTime: new Date().toISOString(),
            authTime: new Date().toISOString(),
          }),
        },
        providerId: 'google.com',
        operationType: 'signIn',
      });
      oauthPromiseRef.current = null;
    }
  };

  const createOAuthUser = async (name: string, email: string, customUid?: string) => {
    const auth = getAuth(driver.sandbox);
    const uid = customUid || `user_${Date.now()}`;
    authSandbox.seedUsers(auth, [
      {
        uid,
        email,
        password: 'password_oauth',
        displayName: name,
      }
    ]);
    selectOAuthUser(uid);
  };

  const deleteOAuthUser = (uid: string) => {
    const auth = getAuth(driver.sandbox);
    authSandbox.deleteUser(auth, uid);
    const users = authSandbox.listUsers(auth).map((u: any) => ({
      uid: u.uid,
      email: u.email || null,
      displayName: u.displayName || null,
    }));
    setOauthUsers(users);
  };

  const cancelOAuthPopup = () => {
    setOauthModalOpen(false);
    if (oauthPromiseRef.current) {
      const err = new Error('Popup closed by user') as any;
      err.code = 'auth/popup-closed-by-user';
      oauthPromiseRef.current.reject(err);
      oauthPromiseRef.current = null;
    }
  };

  const requestPushToken = async () => {
    const token = await service.requestPushToken();
    setFcmToken(token);
    return token;
  };

  const revokePushToken = () => {
    service.clearPushToken();
    setFcmToken(null);
  };

  useEffect(() => {
    if (!initRef.current) {
      initRef.current = true;
      driver.initializeDefaultSecurityRules();
      driver.seedDemoAccounts().then(() => {
        service.signInEmail('alice@example.com', 'password').catch(() => {});
      }).catch(() => {});
    }
  }, [driver, service]);

  useEffect(() => {
    const unsubscribe = service.onAuthChange((user) => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, [service]);

  return (
    <WorkspaceContext.Provider value={{ appService: service, sandboxDriver: driver, currentUser, fcmToken, requestPushToken, revokePushToken, oauthModalOpen, oauthUsers, selectOAuthUser, createOAuthUser, deleteOAuthUser, cancelOAuthPopup }}>
      {children}
    </WorkspaceContext.Provider>
  );
};

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}

export function useTasks(currentUser: any | null) {
  const { appService, sandboxDriver } = useWorkspace();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const unsubscribe = appService.subscribeToTasks(
      (data) => {
        setTasks(data);
        setError(null);
      },
      (err) => {
        setError(err);
        sandboxDriver.logDenialDiagnosticToConsole('Firestore Operation Denied');
      }
    );
    return () => {
      unsubscribe();
    };
  }, [appService, currentUser?.uid, sandboxDriver]);

  useEffect(() => {
    if (error) {
      sandboxDriver.logDenialDiagnosticToConsole('Security Rule Denial Captured');
    }
  }, [error, sandboxDriver]);

  const clearError = () => setError(null);
  return { tasks, error, clearError, setError };
}

export function usePresence() {
  const { appService, sandboxDriver } = useWorkspace();
  const [activeUids, setActiveUids] = useState<string[]>([]);

  useEffect(() => {
    const unsubscribe = appService.subscribeToPresence(
      (uids) => {
        setActiveUids(uids);
      },
      (err) => {
        sandboxDriver.logDenialDiagnosticToConsole('RTDB Presence Listen Denied');
      }
    );
    return () => unsubscribe();
  }, [appService, sandboxDriver]);

  return activeUids;
}

export function useActivityStream() {
  const { appService, sandboxDriver } = useWorkspace();
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    const unsubscribe = appService.subscribeToActivityStream(
      (list) => {
        setEvents(list);
      },
      (err) => {
        sandboxDriver.logDenialDiagnosticToConsole('RTDB Activity Stream Listen Denied');
      }
    );
    return () => unsubscribe();
  }, [appService, sandboxDriver]);

  return events;
}
