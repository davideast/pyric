import type { ToolHandler } from '@inbrowser/agent';
import type { LocalSandbox } from 'pyric/sandbox';
import { getMessagingBroker } from 'pyric/messaging/internal';

/** Read the owning sandbox's retained evidence, never a second broker or store. */
export function createMessagingInspectionTools(resolveSandbox: () => LocalSandbox | Promise<LocalSandbox>): ToolHandler[] {
  return [{
    name: 'messaging_deliveries',
    description: 'Inspect message routing and browser-reported receipt, callback and native display outcomes. handled only means a broker handler ran; display-accepted is not proof of OS visibility. Missing receipt is unconfirmed.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const sandbox = await resolveSandbox();
      const deliveries = getMessagingBroker(sandbox).deliveries();
      return { ok: true, summary: `${deliveries.length} deliveries`, data: { deliveries } };
    },
  }];
}
