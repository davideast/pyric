/**
 * `httpProjectStore(baseUrl)`: a {@link ProjectStore} that satisfies the port
 * browser-side over the pyric devr's `/__pyric/projects` routes. `open(id)`
 * returns a {@link ProjectHandle} whose `workspace` is an {@link httpWorkspace}
 * over the same origin (the server's single-project `/__pyric/workspace`).
 *
 * NOTE: `pyric dev --ui` serves ONE project tree at `/__pyric/workspace`, so
 * every `open(id).workspace` points at the same server-side tree. In multi-
 * project/hosted modes the route would be id-scoped; the port shape already
 * anticipates that (see the design rationale).
 */
import type {
  ProjectHandle,
  ProjectMeta,
  ProjectStore,
} from '../ports.js';
import { httpWorkspace } from './http-workspace.js';

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

export function httpProjectStore(baseUrl: string): ProjectStore {
  const base = baseUrl;

  return {
    async list() {
      const res = await fetch(joinUrl(base, '/__pyric/projects'));
      if (!res.ok) throw new Error(`projects.list() → ${res.status}`);
      return (await res.json()) as ProjectMeta[];
    },

    async open(id) {
      const res = await fetch(
        joinUrl(base, `/__pyric/projects/${encodeURIComponent(id)}`),
      );
      if (!res.ok) throw new Error(`projects.open(${id}) → ${res.status}`);
      const meta = (await res.json()) as ProjectMeta;
      const handle: ProjectHandle = {
        meta,
        workspace: httpWorkspace(base),
      };
      return handle;
    },

    async create(input) {
      const res = await fetch(joinUrl(base, '/__pyric/projects'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`projects.create() → ${res.status}`);
      return (await res.json()) as ProjectMeta;
    },

    async update(id, patch) {
      const res = await fetch(
        joinUrl(base, `/__pyric/projects/${encodeURIComponent(id)}`),
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) throw new Error(`projects.update(${id}) → ${res.status}`);
    },

    async remove(id) {
      const res = await fetch(
        joinUrl(base, `/__pyric/projects/${encodeURIComponent(id)}`),
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error(`projects.remove(${id}) → ${res.status}`);
    },
  };
}
