import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import type { DiagnosticSnapshot } from './diagnostics.js';

export const UPSTREAM_REPOSITORY = 'FetchUpstream/pi-to-pi';
const MAX_NARRATIVE = 2_000;
const MAX_REASON = 256;

export interface ModelIssueReport {
  readonly title: string;
  readonly description: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly operation?: string;
  readonly requestId?: string;
  readonly peerRuntimeId?: string;
}

export interface IssueReportInput extends ModelIssueReport {
  readonly diagnostics: DiagnosticSnapshot;
}

export type IssueReportResult =
  | { readonly status: 'created' | 'existing'; readonly number: number; readonly url: string }
  | { readonly status: 'unavailable' | 'failed'; readonly reason: string };

export interface IssueReporter {
  report(input: IssueReportInput): Promise<IssueReportResult>;
}

export interface GhCommandRunner {
  run(
    args: readonly string[],
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

const executeFile = promisify(execFile);

export const ghCommandRunner: GhCommandRunner = {
  async run(
    args,
  ): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
    try {
      const { stdout, stderr } = await executeFile('gh', [...args], {
        timeout: 10_000,
        maxBuffer: 16 * 1024,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const result = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
      return {
        code: typeof result.code === 'number' ? result.code : 1,
        stdout: typeof result.stdout === 'string' ? result.stdout.slice(0, 16 * 1024) : '',
        stderr: typeof result.stderr === 'string' ? result.stderr.slice(0, 16 * 1024) : '',
      };
    }
  },
};

function safeText(value: string | undefined, fallback = ''): string {
  return (
    Array.from(value ?? '')
      .map((character) => (character.charCodeAt(0) < 32 ? ' ' : character))
      .join('')
      .trim()
      .slice(0, MAX_NARRATIVE) || fallback
  );
}

function reason(value: string): string {
  return safeText(value, 'GitHub reporting failed').slice(0, MAX_REASON);
}

export function fingerprint(snapshot: DiagnosticSnapshot): string {
  const stable = {
    packageVersion: snapshot.packageVersion,
    platform: snapshot.platform,
    operation: snapshot.operation,
    requestId: snapshot.requestId,
    peerRuntimeId: snapshot.peerRuntimeId,
    taskState: snapshot.taskState,
    eventCodes: snapshot.events.map((item) => [
      item.component,
      item.name,
      item.operation,
      item.code,
    ]),
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function renderIssueBody(
  input: IssueReportInput,
  hash = fingerprint(input.diagnostics),
): string {
  const diagnostics = JSON.stringify(input.diagnostics, null, 2);
  return [
    `<!-- p2p-fingerprint: ${hash} -->`,
    '## Agent report (untrusted narrative)',
    safeText(input.description, 'No description supplied.'),
    '## Expected',
    safeText(input.expected, 'Not supplied.'),
    '## Actual',
    safeText(input.actual, 'Not supplied.'),
    '## Automatically collected Pi-to-Pi diagnostics',
    '```json',
    diagnostics,
    '```',
    '## Recent Pi-to-Pi diagnostic events',
    '```json',
    JSON.stringify(input.diagnostics.events, null, 2),
    '```',
    '## Sanitization',
    'Sensitive conversation content, credentials, environment values, paths, and transcripts were not attached automatically.',
  ].join('\n\n');
}

/** Fixed-repository, injectable local gh CLI integration. */
export class GhIssueReporter implements IssueReporter {
  public constructor(private readonly runner: GhCommandRunner) {}

  public async report(input: IssueReportInput): Promise<IssueReportResult> {
    try {
      const auth = await this.runner.run(['auth', 'status']);
      if (auth.code !== 0)
        return { status: 'unavailable', reason: 'GitHub CLI authentication is unavailable' };
      const hash = fingerprint(input.diagnostics);
      const marker = `p2p-fingerprint: ${hash}`;
      const search = await this.runner.run([
        'issue',
        'list',
        '--repo',
        UPSTREAM_REPOSITORY,
        '--state',
        'open',
        '--search',
        marker,
        '--json',
        'number,url,body',
      ]);
      if (search.code !== 0)
        return { status: 'failed', reason: reason('Unable to search existing upstream issues') };
      const issues = JSON.parse(search.stdout) as unknown;
      if (Array.isArray(issues)) {
        const found = issues.find(
          (item): item is { number: number; url: string; body?: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { number?: unknown }).number === 'number' &&
            typeof (item as { url?: unknown }).url === 'string' &&
            String((item as { body?: unknown }).body ?? '').includes(marker),
        );
        if (found !== undefined)
          return { status: 'existing', number: found.number, url: found.url };
      }
      const created = await this.runner.run([
        'issue',
        'create',
        '--repo',
        UPSTREAM_REPOSITORY,
        '--title',
        safeText(input.title, 'Pi-to-Pi defect'),
        '--body',
        renderIssueBody(input, hash),
      ]);
      if (created.code !== 0)
        return { status: 'failed', reason: reason('Unable to create upstream issue') };
      const url = created.stdout
        .trim()
        .split(/\s+/)
        .find((value) => value.startsWith('https://'));
      const match = url?.match(/\/(\d+)(?:\?.*)?$/);
      return url !== undefined && match !== null
        ? { status: 'created', number: Number(match?.[1]), url }
        : { status: 'failed', reason: 'Upstream issue creation returned no issue URL' };
    } catch {
      return { status: 'unavailable', reason: 'GitHub CLI is unavailable' };
    }
  }
}

export const unavailableIssueReporter: IssueReporter = {
  async report(): Promise<IssueReportResult> {
    return { status: 'unavailable', reason: 'GitHub reporting is unavailable' };
  },
};
