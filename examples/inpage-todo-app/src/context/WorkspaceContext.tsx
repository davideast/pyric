import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { User } from 'pyric/auth';
import { TaskApplicationService, type TaskItem, type ActivityEvent } from '../services/firebase-service';
import { SandboxSimulationDriver } from '../sandbox/sandbox-driver';

export interface WorkspaceContextValue {
  appService: TaskApplicationService;
  sandboxDriver: SandboxSimulationDriver;
  currentUser: User | null;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

let singletonDriver: SandboxSimulationDriver | null = null;
let singletonService: TaskApplicationService | null = null;
let isInitialized = false;

function getWorkspaceSingletons(): { appService: TaskApplicationService; sandboxDriver: SandboxSimulationDriver } {
  if (!singletonDriver || !singletonService) {
    singletonDriver = new SandboxSimulationDriver('inpage-task-workspace');
    singletonDriver.initializeDefaultSecurityRules();
    singletonService = new TaskApplicationService(singletonDriver.sandbox);
  }
  return { appService: singletonService, sandboxDriver: singletonDriver };
}

export const WorkspaceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { appService, sandboxDriver } = useRef(getWorkspaceSingletons()).current;
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  useEffect(() => {
    if (!isInitialized) {
      isInitialized = true;
      sandboxDriver.seedDemoAccounts().catch((err) => {
        console.warn('Failed to seed sandbox profiles:', err);
      });
    }

    const unsubscribe = appService.onAuthChange((user) => {
      setCurrentUser(user);
    });

    return () => {
      unsubscribe();
    };
  }, [appService, sandboxDriver]);

  return (
    <WorkspaceContext.Provider value={{ appService, sandboxDriver, currentUser }}>
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

export function useTasks(currentUser: User | null) {
  const { appService } = useWorkspace();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [error, setError] = useState<any>(null);

  useEffect(() => {
    if (!currentUser) {
      setTasks([]);
      return;
    }

    const unsubscribe = appService.subscribeToTasks(
      (items) => {
        setTasks(items);
      },
      (err) => {
        setError(err);
      }
    );

    return () => {
      unsubscribe();
    };
  }, [appService, currentUser?.uid]);

  const clearError = () => setError(null);
  return { tasks, error, clearError, setError };
}

export function usePresence() {
  const { appService } = useWorkspace();
  const [activeUids, setActiveUids] = useState<string[]>([]);

  useEffect(() => {
    const unsubscribe = appService.subscribeToPresence((uids) => {
      setActiveUids(uids);
    });
    return () => unsubscribe();
  }, [appService]);

  return activeUids;
}

export function useActivityStream() {
  const { appService } = useWorkspace();
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    const unsubscribe = appService.subscribeToActivityStream((list) => {
      setEvents(list);
    });
    return () => unsubscribe();
  }, [appService]);

  return events;
}
