import { AuditWriteFailed } from "./errors.ts";
import { now, write } from "./sink.ts";

export interface AuditRecord {
  category: string;
  from: string;
  to: string;
  quantity: number;
  result: number;
}

/**
 * Sends exactly one entry to the sink, stamped with the sink's own clock.
 * Keeps no copy and never retries; a sink failure is returned, not thrown.
 */
export async function record(entry: AuditRecord): Promise<AuditWriteFailed | undefined> {
  try {
    await write({ ...entry, timestamp: now() });
    return undefined;
  } catch (cause) {
    return new AuditWriteFailed(cause);
  }
}
