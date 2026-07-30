import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { TaskApplicationService, type TaskItem, type ActivityEvent } from '../services/firebase-service';
import { SandboxSimulationDriver } from '../sandbox/sandbox-driver';

interface WorkspaceContextValue {
  appService: TaskApplicationService;
  sandboxDriver: SandboxSimulationDriver;
  currentUser: any | null;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export const WorkspaceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initRef = useRef<boolean>(false);
  const [driver] = useState(() => new SandboxSimulationDriver('inpage-task-workspace'));
  const [service] = useState(() => new TaskApplicationService(driver.sandbox));
  const [currentUser, setCurrentUser] = useState<any | null>(null);

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
    <WorkspaceContext.Provider value={{ appService: service, sandboxDriver: driver, currentUser }}>
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
