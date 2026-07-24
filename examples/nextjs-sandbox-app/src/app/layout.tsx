import type { Metadata } from 'next';
import React from 'react';

export const metadata: Metadata = {
  title: 'nextjs-sandbox-app',
  description: 'Local Firebase development with Pyric and Next.js',
};

interface LayoutProps {
  children: React.ReactNode;
}

export default function RootLayout({ children }: LayoutProps): React.JSX.Element {
  const containerStyle: React.CSSProperties = {
    font: '16px/1.5 system-ui, sans-serif',
    maxWidth: '640px',
    margin: '3rem auto',
    padding: '0 1rem',
  };

  return (
    <html lang="en">
      <body style={containerStyle}>
        {children}
      </body>
    </html>
  );
}
