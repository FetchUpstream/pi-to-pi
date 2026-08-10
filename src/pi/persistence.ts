import type { PiTaskAuditMetadata } from './messages.js';

/**
 * Audit entries are intentionally display-only. No loader in this module creates
 * or adopts router tasks, so copied Pi history cannot acquire live ownership.
 */
export function createTaskAuditEntry(metadata: PiTaskAuditMetadata): PiTaskAuditMetadata {
  return Object.freeze({ ...metadata });
}

export function isTaskAuditEntry(value: unknown): value is PiTaskAuditMetadata {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.requestId === 'string' &&
    (entry.direction === 'inbound' || entry.direction === 'outbound') &&
    typeof entry.peerRuntimeId === 'string' &&
    typeof entry.state === 'string' &&
    typeof entry.timestamp === 'string'
  );
}
