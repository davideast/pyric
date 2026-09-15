# Teams workspace

## Platform
web

## Purpose
A regular collaborative teams application that showcases Pyric observability in development. The app uses Firebase SDKs; only Vite configuration knows about Pyric.

## Confirmed requirements
Follow the supplied Brainwave Figma references. Start signed out and offer a normal sign-in/create-account flow. Never force a session or expose impersonation controls in application UI. The automatically injected runtime chip owns developer controls. Keep a separate Demo scenarios panel.

## Stack
React, TypeScript, Firebase SDK, Vite and the @pyric/cli Vite plugin. Seed data and rules belong in development/project configuration, never in browser application code.
