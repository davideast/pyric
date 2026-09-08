/**
 * Node-side composition of the tool metadata and handlers served over MCP.
 */

import type { ToolHandler } from '@inbrowser/agent';
import { toolFamilies, type ForwardedFamilyKey, type InProcessFamilyKey } from '../tool-families.js';
import {
  FORWARDED_METADATA_FACTORIES,
  IN_PROCESS_HANDLER_FACTORIES,
  type InProcessToolContext,
  type StubResolver,
} from './tool-family-factories.js';

export type { InProcessToolContext };

export interface ToolMetadata {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function toMetadata(handler: ToolHandler): ToolMetadata {
  return {
    name: handler.name,
    description: handler.description,
    parameters: handler.parameters as Record<string, unknown>,
  };
}

export function getSandboxToolMetadata(): ToolMetadata[] {
  const stub: StubResolver = () => {
    throw new Error(
      'BUG: sandbox-tool factory executor invoked on the bridge side — should have been replaced'
    );
  };
  return toolFamilies('forwarded')
    .flatMap((family) => FORWARDED_METADATA_FACTORIES[family.key as ForwardedFamilyKey](stub))
    .map(toMetadata);
}

export function getInProcessToolHandlers(context?: InProcessToolContext): ToolHandler[] {
  return toolFamilies('in-process').flatMap((family) =>
    IN_PROCESS_HANDLER_FACTORIES[family.key as InProcessFamilyKey](context)
  );
}
