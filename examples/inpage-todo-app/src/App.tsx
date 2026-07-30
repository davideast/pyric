import React, { useState } from 'react';
import { useWorkspace, useTasks } from './context/WorkspaceContext';
import { TaskHeader } from './components/TaskHeader';
import { TaskCreationForm } from './components/TaskCreationForm';
import { TaskListView } from './components/TaskListView';
import { ProgressFooter } from './components/ProgressFooter';
import { ErrorBanner } from './components/ErrorBanner';
import { AuthenticationDialog } from './components/AuthenticationDialog';
import { DeveloperConsoleModal } from './components/DeveloperConsoleModal';
import { ToastContainer } from './components/ToastContainer';

export const App: React.FC = () => {
  const { appService, currentUser } = useWorkspace();
  const { tasks, error, clearError, setError } = useTasks(currentUser);

  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const handleAddTask = async (
    title: string,
    category: string,
    priority: 'Low' | 'Medium' | 'High',
    attachmentUrl?: string
  ) => {
    await appService.addTask(title, category, priority, attachmentUrl);
  };

  const handleUploadAttachment = async (file: File): Promise<string> => {
    return appService.uploadTaskAttachment(file);
  };

  const handleToggleStatus = async (id: string, newStatus: boolean, owner: string) => {
    await appService.toggleTaskStatus(id, newStatus, owner);
  };

  const handleUpdateTitle = async (id: string, newTitle: string, owner: string) => {
    await appService.updateTaskTitle(id, newTitle, owner);
  };

  const handleDelete = async (id: string) => {
    await appService.removeTask(id);
  };

  const handleClearCompleted = async () => {
    try {
      await appService.clearCompletedTasks(tasks);
    } catch (err: any) {
      setError(err);
    }
  };

  const handleEnablePush = async () => {
    try {
      await appService.requestPushToken();
    } catch (err: any) {
      setError(err);
    }
  };

  const handleRevokePush = () => {
    appService.clearPushToken();
  };

  const handleSignInEmail = async (email: string, pass: string) => {
    await appService.signInEmail(email, pass);
  };

  const handleSignInGoogle = async () => {
    await appService.signInGoogle();
  };

  const handleSignInGuest = async () => {
    await appService.signInGuest();
  };

  const handleAcceptAiTask = async (
    title: string,
    category: string,
    priority: 'Low' | 'Medium' | 'High'
  ) => {
    await appService.addTask(title, category, priority);
  };

  return (
    <>
      <ToastContainer />

      <main className="max-w-2xl w-full flex flex-col gap-8 sm:gap-10 my-auto select-text cursor-default">
        <ErrorBanner
          errorTitle="Security Rules Denial or Operation Exception"
          errorDetails={error}
          onClose={clearError}
          onOpenConsole={() => setIsConsoleOpen(true)}
        />

        <TaskHeader
          tasks={tasks}
          currentUser={currentUser}
          onOpenSignIn={() => setIsAuthOpen(true)}
          onSignOut={() => appService.signOutUser()}
          onEnablePush={handleEnablePush}
          onRevokePush={handleRevokePush}
          fcmToken={appService.getActiveToken()}
          onOpenConsole={() => setIsConsoleOpen(true)}
        />

        <TaskCreationForm
          onAddTask={handleAddTask}
          onUploadAttachment={handleUploadAttachment}
          onError={(_, err) => setError(err)}
        />

        <TaskListView
          tasks={tasks}
          currentUserId={currentUser ? currentUser.uid : 'anonymous'}
          activeFilter={activeFilter}
          onFilterChange={setActiveFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onToggleStatus={handleToggleStatus}
          onUpdateTitle={handleUpdateTitle}
          onDelete={handleDelete}
          onClearCompleted={handleClearCompleted}
        />

        <ProgressFooter />
      </main>

      <AuthenticationDialog
        isOpen={isAuthOpen}
        onClose={() => setIsAuthOpen(false)}
        onSignInEmail={handleSignInEmail}
        onSignInGoogle={handleSignInGoogle}
        onSignInGuest={handleSignInGuest}
      />

      <DeveloperConsoleModal
        isOpen={isConsoleOpen}
        onClose={() => setIsConsoleOpen(false)}
        onAcceptAiTask={handleAcceptAiTask}
        onError={(_, err) => setError(err)}
        fcmToken={appService.getActiveToken()}
      />
    </>
  );
};
