import React from 'react';

export const ProgressFooter: React.FC = () => {
  return (
    <footer className="text-center text-xs text-[var(--app-muted-foreground)] pt-2 pb-6 select-text cursor-default">
      Powered by <span className="font-semibold text-[var(--app-foreground)]">Pyric</span> In-Page
      Sandbox & reactive Web SDK abstractions.
    </footer>
  );
};
