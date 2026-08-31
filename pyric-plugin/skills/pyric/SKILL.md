---
name: pyric
description: Install the current Pyric CLI, start this project's sandbox bridge, and open the app so the in-page sandbox connects. Use before asking an agent to work with Firestore, Auth, or another Firebase service through Pyric.
---

# Start pyric

Get one current Pyric sandbox running and wired to this session.

## Use the current package and APIs

- Use only `@pyric/cli@latest` for the CLI and build integrations.
- Import `{ pyric }` from `@pyric/cli/vite`.
- Use `pyric({ bridge: true })` for a Vite bridge.
- Use `pyric/rules/internal/node` for the Node-only Rules entry point.
- Never use `pyricSandbox`. It is the retired Vite plugin name.
- Never downgrade Pyric or add a `pyric` override to make a retired name resolve.
- Never scaffold with `pyric init`; an old global CLI can carry a stale embedded template. Use
  `npm create pyric@latest` for a new project.
- Never add an absolute `file:/...` dependency that points at a global npm installation.

If the project contains another Pyric CLI/build dependency, `pyricSandbox`, `pyric/rules/node`, or
an old compatibility override, migrate it to the current forms above and update the lockfile with
the project's package manager.

## Start one launcher

1. Inspect `package.json`, the lockfile, `vite.config.*`, `firebase.json`, and `pyric.json`.
2. If the directory has no application yet, scaffold the current Vite template with
   `npm create pyric@latest`. Do not use a globally installed `pyric` executable.
3. For an existing project, install or update the development dependency with its package manager:
   `@pyric/cli@latest`. Remove any superseded Pyric CLI/build dependency through the same package
   manager.
4. Choose one launcher:
   - **Vite:** Edit the existing Vite configuration in place. Import `pyric` from
     `@pyric/cli/vite` and ensure the existing `plugins` array contains one
     `pyric({ bridge: true })` call. Do not add a second `plugins` property. Start the existing
     dev script, such as `npm run dev` or `bun run dev`. Do not also start `pyric sandbox`.
   - **Existing non-Vite app:** Preserve its development command. Replace any retired
     Pyric launcher with `pyric sandbox`. Put Pyric flags before the
     first child command token. Use `--` to separate the child command when it could be
     mistaken for a Pyric flag. A complete command looks like
     `pyric sandbox --bridge --persist --json -- <command>`. If `pyric.json` defines
     `command`, pass that command explicitly after `--` because `--json` without an explicit
     command starts only the sandbox host. Run the script with the project's package manager.
   - **No existing development command:** Run the project-local CLI with
     `npx --no-install pyric sandbox --bridge --persist --json`.
5. Keep the URL printed by the launcher.
6. Keep the dev server running in the background. Avoid restarting it after the bridge connects.

## Connect and verify

The plugin's `pyric` MCP server uses the stdio proxy to discover `.pyric/serve.json`. Do not add a
static MCP URL or run a separate `claude mcp add` command.

Open the served URL in a browser. The data-plane tools require the in-page sandbox. Request
`<url>/__pyric/health` and confirm `"sandboxConnected": true`.

Report the URL and the successful health result before doing Pyric work. If health reports
`false`, open the page and check again.
