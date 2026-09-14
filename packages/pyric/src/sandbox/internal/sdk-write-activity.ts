import type { UsageEvidence } from './usage-evidence.js';
import type { SdkActivityHandle } from './sdk-activity.js';

/** A write acknowledgment is not a data delivery. Preserve the operation's error. */
export async function runSdkWrite<T>(activity: SdkActivityHandle, write: () => T | PromiseLike<T>, usage?: () => UsageEvidence): Promise<T> {
  try {
    const result = await write();
    activity.complete(usage?.());
    return result;
  } catch (error) {
    activity.fail();
    throw error;
  }
}
