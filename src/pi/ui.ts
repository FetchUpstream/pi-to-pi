import type { PiTaskAuditMetadata } from './messages.js';

export function renderPeerSummary(peer: {
  readonly displayName: string;
  readonly runtimeId: string;
  readonly state: string;
}): string {
  return `${peer.displayName} (${peer.runtimeId}) — ${peer.state}`;
}

export function renderTaskAudit(audit: PiTaskAuditMetadata): string {
  return `${audit.direction} ${audit.requestId} · ${audit.peerRuntimeId} · ${audit.state}`;
}
