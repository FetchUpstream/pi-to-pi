import { describe, expect, it } from 'vitest';

import { DiagnosticEventRing, formatDiagnosticSnapshot } from '../../src/diagnostics.js';
import { GhIssueReporter, fingerprint, renderIssueBody } from '../../src/issue-reporter.js';

function snapshot() {
  return formatDiagnosticSnapshot({
    timestamp: '2026-01-01T00:00:00.000Z',
    packageVersion: '1',
    runtimeId: 'runtime',
    roomId: 'room',
    platform: 'linux',
    lifecycle: 'started',
    operation: 'transport',
    events: [],
  });
}

describe('issue reporting diagnostics', () => {
  it('evicts old events and excludes unapproved properties', () => {
    const ring = new DiagnosticEventRing(2);
    ring.record({ component: 'router', name: 'first', code: 'a' });
    ring.record({ component: 'router', name: 'second', code: 'b' });
    ring.record({ component: 'router', name: 'third', code: 'c' });
    expect(ring.list().map((event) => event.name)).toEqual(['second', 'third']);
    expect(JSON.stringify(ring.list())).not.toContain('message');
  });

  it('uses stable automatic fingerprints and separated sanitized issue sections', () => {
    const report = { title: 'Failure', description: 'agent narrative', diagnostics: snapshot() };
    expect(fingerprint(snapshot())).toBe(fingerprint(snapshot()));
    expect(renderIssueBody(report)).toContain('## Automatically collected Pi-to-Pi diagnostics');
    expect(renderIssueBody(report)).toContain('## Sanitization');
  });

  it('reuses a matching fixed-repository issue', async () => {
    const hash = fingerprint(snapshot());
    const runner = {
      run: async () => ({
        code: 0,
        stdout: JSON.stringify([
          {
            number: 7,
            url: 'https://github.com/FetchUpstream/pi-to-pi/issues/7',
            body: `<!-- p2p-fingerprint: ${hash} -->`,
          },
        ]),
        stderr: '',
      }),
    };
    const result = await new GhIssueReporter(runner).report({
      title: 'Failure',
      description: 'narrative',
      diagnostics: snapshot(),
    });
    expect(result).toEqual({
      status: 'existing',
      number: 7,
      url: 'https://github.com/FetchUpstream/pi-to-pi/issues/7',
    });
  });
});
