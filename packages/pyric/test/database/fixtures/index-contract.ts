import type { Database } from '../../../src/database/index.js';

declare const database: Database;
void database;

// @ts-expect-error Legacy host types must not leak from the mirror entry.
import type { RtdbHost } from '../../../src/database/index.js';
// @ts-expect-error Legacy app adapter types must not leak from the mirror entry.
import type { AgentAppLike } from '../../../src/database/index.js';
// @ts-expect-error Legacy replay types must not leak from the mirror entry.
import type { RtdbReplayOptions } from '../../../src/database/index.js';
// @ts-expect-error Legacy agent-tool dependency types must not leak from the mirror entry.
import type { RtdbAdminToolDeps } from '../../../src/database/index.js';
// @ts-expect-error Legacy stateful IR types must not leak from the mirror entry.
import type { RtdbIR } from '../../../src/database/index.js';

export {};
