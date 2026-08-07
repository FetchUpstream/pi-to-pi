import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_MAX_JSON_LINE_BYTES = 64 * 1024;
export const DEFAULT_MAX_JSON_CHUNK_BYTES = 64 * 1024;

export type OutputStream = 'stdout' | 'stderr';
export type ProcessIdentity =
  | string
  | number
  | {
      readonly id?: string;
      readonly label?: string;
      readonly name?: string;
      readonly pid?: number;
    };

export interface BoundedOutputOptions {
  /** Maximum retained bytes for each stream unless overridden below. */
  readonly maxBytes?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly encoding?: BufferEncoding;
}

export interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  /** Total bytes observed, including bytes discarded after the bound. */
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTotalBytes: number;
  readonly stderrTotalBytes: number;
  readonly stdoutRetainedBytes: number;
  readonly stderrRetainedBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProcessDiagnostics {
  readonly identity?: ProcessIdentity;
  readonly state?: string;
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly spawnError?: unknown;
  readonly output?: CapturedOutput;
}

/**
 * Stores stdout and stderr independently, retaining at most the configured
 * number of bytes for each stream while still counting all observed bytes.
 */
export class BoundedOutput {
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly encoding: BufferEncoding;

  private readonly stdoutBuffer: BoundedStream;
  private readonly stderrBuffer: BoundedStream;

  constructor(options: BoundedOutputOptions = {}) {
    const maxBytes = validateMaxBytes(options.maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 'max bytes');
    this.maxStdoutBytes = validateMaxBytes(options.maxStdoutBytes ?? maxBytes, 'max stdout bytes');
    this.maxStderrBytes = validateMaxBytes(options.maxStderrBytes ?? maxBytes, 'max stderr bytes');
    this.encoding = options.encoding ?? 'utf8';
    this.stdoutBuffer = new BoundedStream(this.maxStdoutBytes, this.encoding);
    this.stderrBuffer = new BoundedStream(this.maxStderrBytes, this.encoding);
  }

  append(stream: OutputStream, chunk: Uint8Array | string): void {
    this.streamFor(stream).append(chunk);
  }

  appendStdout(chunk: Uint8Array | string): void {
    this.stdoutBuffer.append(chunk);
  }

  appendStderr(chunk: Uint8Array | string): void {
    this.stderrBuffer.append(chunk);
  }

  get stdout(): string {
    return this.stdoutBuffer.text;
  }

  get stderr(): string {
    return this.stderrBuffer.text;
  }

  get stdoutBytes(): number {
    return this.stdoutBuffer.totalBytes;
  }

  get stderrBytes(): number {
    return this.stderrBuffer.totalBytes;
  }

  get stdoutTruncated(): boolean {
    return this.stdoutBuffer.truncated;
  }

  get stderrTruncated(): boolean {
    return this.stderrBuffer.truncated;
  }

  snapshot(): CapturedOutput {
    return {
      stdout: this.stdoutBuffer.text,
      stderr: this.stderrBuffer.text,
      stdoutBytes: this.stdoutBuffer.totalBytes,
      stderrBytes: this.stderrBuffer.totalBytes,
      stdoutTotalBytes: this.stdoutBuffer.totalBytes,
      stderrTotalBytes: this.stderrBuffer.totalBytes,
      stdoutRetainedBytes: this.stdoutBuffer.retainedBytes,
      stderrRetainedBytes: this.stderrBuffer.retainedBytes,
      stdoutTruncated: this.stdoutBuffer.truncated,
      stderrTruncated: this.stderrBuffer.truncated,
    };
  }

  diagnostics(options: Omit<ProcessDiagnostics, 'output'> = {}): string {
    return formatProcessDiagnostics({ ...options, output: this.snapshot() });
  }

  clear(): void {
    this.stdoutBuffer.clear();
    this.stderrBuffer.clear();
  }

  private streamFor(stream: OutputStream): BoundedStream {
    return stream === 'stdout' ? this.stdoutBuffer : this.stderrBuffer;
  }
}

/** Creates an independent bounded output collector for child-process streams. */
export function createBoundedOutput(options: BoundedOutputOptions = {}): BoundedOutput {
  return new BoundedOutput(options);
}

export function formatProcessIdentity(identity: ProcessIdentity = 'unknown process'): string {
  if (typeof identity === 'string') {
    return identity;
  }
  if (typeof identity === 'number') {
    return `pid ${identity}`;
  }

  const label = identity.label ?? identity.name ?? identity.id;
  if (label && identity.pid !== undefined) {
    return `${label} (pid ${identity.pid})`;
  }
  if (label) {
    return label;
  }
  if (identity.pid !== undefined) {
    return `pid ${identity.pid}`;
  }
  return 'unknown process';
}

/**
 * Formats process identity, lifecycle state, exit information, spawn errors,
 * and bounded output into a failure-friendly diagnostic string.
 */
export function formatProcessDiagnostics(diagnostics: ProcessDiagnostics = {}): string {
  const lines = [`Process: ${formatProcessIdentity(diagnostics.identity)}`];
  if (diagnostics.state !== undefined) {
    lines.push(`State: ${diagnostics.state}`);
  }
  if (diagnostics.exitCode !== undefined) {
    lines.push(`Exit code: ${diagnostics.exitCode === null ? 'null' : diagnostics.exitCode}`);
  }
  if (diagnostics.signal !== undefined) {
    lines.push(`Signal: ${diagnostics.signal ?? 'null'}`);
  }
  if (diagnostics.spawnError !== undefined) {
    lines.push(`Spawn error: ${formatUnknownError(diagnostics.spawnError)}`);
  }
  if (diagnostics.output) {
    lines.push(...formatCapturedOutput(diagnostics.output));
  }
  return lines.join('\n');
}

export interface JsonLinesParserOptions<T> {
  readonly maxLineBytes?: number;
  /** Maximum bytes processed from one input chunk at a time. */
  readonly maxChunkBytes?: number;
  readonly identity?: ProcessIdentity;
  /** A snapshot captured at parser construction time. */
  readonly output?: CapturedOutput;
  /** Called when a parse error occurs so diagnostics reflect current output. */
  readonly getOutput?: () => CapturedOutput | undefined;
  /** Optional parser for a complete line; defaults to `JSON.parse`. */
  readonly parse?: (line: string) => T;
}

export interface JsonLinesParseErrorOptions {
  readonly lineNumber: number;
  readonly line: string;
  readonly identity?: ProcessIdentity;
  readonly output?: CapturedOutput;
  readonly cause?: unknown;
}

export class JsonLinesParseError extends Error {
  readonly code = 'ERR_JSON_LINES_PARSE';
  readonly lineNumber: number;
  readonly line: string;
  readonly identity?: ProcessIdentity;
  readonly output?: CapturedOutput;

  constructor(options: JsonLinesParseErrorOptions) {
    const identity = formatProcessIdentity(options.identity);
    const cause =
      options.cause === undefined ? 'invalid JSON-lines event' : formatUnknownError(options.cause);
    const diagnostic = formatProcessDiagnostics({
      identity: options.identity,
      output: options.output,
    });
    super(
      `Unable to parse JSON-lines event from ${identity} at line ${options.lineNumber}: ${cause}. ` +
        `Line: ${JSON.stringify(limitDiagnosticText(options.line))}\n${diagnostic}`,
      { cause: options.cause },
    );
    this.name = 'JsonLinesParseError';
    this.lineNumber = options.lineNumber;
    this.line = options.line;
    this.identity = options.identity;
    this.output = options.output;
  }
}

/** Incrementally parses JSON values from newline-delimited input. */
export class JsonLinesParser<T = unknown> {
  readonly maxLineBytes: number;
  readonly maxChunkBytes: number;

  private readonly decoder = new StringDecoder('utf8');
  private readonly identity?: ProcessIdentity;
  private readonly output?: CapturedOutput;
  private readonly getOutput?: () => CapturedOutput | undefined;
  private readonly parseLineValue: (line: string) => T;
  private pending = '';
  private lineNumber = 0;
  private ended = false;

  constructor(options: JsonLinesParserOptions<T> = {}) {
    this.maxLineBytes = validateMaxBytes(
      options.maxLineBytes ?? DEFAULT_MAX_JSON_LINE_BYTES,
      'max JSON line bytes',
    );
    this.maxChunkBytes = validatePositiveMaxBytes(
      options.maxChunkBytes ?? DEFAULT_MAX_JSON_CHUNK_BYTES,
      'max JSON chunk bytes',
    );
    this.identity = options.identity;
    this.output = options.output;
    this.getOutput = options.getOutput;
    this.parseLineValue = options.parse ?? ((line: string) => JSON.parse(line) as T);
  }

  /** Feeds a chunk and returns every complete event found in that chunk. */
  push(chunk: Uint8Array | string): T[] {
    this.assertOpen();
    const events: T[] = [];
    if (typeof chunk === 'string') {
      let offset = 0;
      while (offset < chunk.length) {
        const end = nextStringChunkEnd(chunk, offset, this.maxChunkBytes);
        events.push(
          ...this.consume(this.decoder.write(Buffer.from(chunk.slice(offset, end), 'utf8'))),
        );
        offset = end;
      }
      return events;
    }

    for (let offset = 0; offset < chunk.byteLength; offset += this.maxChunkBytes) {
      const end = Math.min(offset + this.maxChunkBytes, chunk.byteLength);
      events.push(...this.consume(this.decoder.write(chunk.subarray(offset, end))));
    }
    return events;
  }

  /**
   * Flushes the decoder and parses a final unterminated JSON line, if present.
   * Calling `end()` repeatedly is safe and returns no duplicate events.
   */
  end(): T[] {
    if (this.ended) {
      return [];
    }
    this.ended = true;
    const events = this.consume(this.decoder.end());
    if (this.pending !== '') {
      const parsed = this.parseLine(this.pending);
      if (parsed !== EMPTY_LINE) {
        events.push(parsed);
      }
    }
    this.pending = '';
    return events;
  }

  private consume(text: string): T[] {
    this.pending += text;
    const events: T[] = [];
    let newlineIndex = this.pending.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = this.pending.slice(0, newlineIndex).replace(/\r$/, '');
      this.pending = this.pending.slice(newlineIndex + 1);
      const parsed = this.parseLine(line);
      if (parsed !== EMPTY_LINE) {
        events.push(parsed);
      }
      newlineIndex = this.pending.indexOf('\n');
    }

    this.assertPendingBound();
    return events;
  }

  private parseLine(line: string): T | typeof EMPTY_LINE {
    this.lineNumber += 1;
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      throw new JsonLinesParseError({
        cause: new Error(`line exceeds ${this.maxLineBytes} bytes`),
        identity: this.identity,
        line: limitDiagnosticText(line),
        lineNumber: this.lineNumber,
        output: this.getOutput?.() ?? this.output,
      });
    }
    if (line.trim() === '') {
      return EMPTY_LINE;
    }

    try {
      return this.parseLineValue(line);
    } catch (cause) {
      throw new JsonLinesParseError({
        cause,
        identity: this.identity,
        line,
        lineNumber: this.lineNumber,
        output: this.getOutput?.() ?? this.output,
      });
    }
  }

  private assertPendingBound(): void {
    const pendingBytes = Buffer.byteLength(this.pending, 'utf8');
    if (pendingBytes <= this.maxLineBytes) {
      return;
    }

    const line = limitDiagnosticText(this.pending);
    throw new JsonLinesParseError({
      cause: new Error(`line exceeds ${this.maxLineBytes} bytes`),
      identity: this.identity,
      line,
      lineNumber: this.lineNumber + 1,
      output: this.getOutput?.() ?? this.output,
    });
  }

  private assertOpen(): void {
    if (this.ended) {
      throw new Error('Cannot push data after a JSON-lines parser has ended');
    }
  }
}

/** Parses a complete JSON-lines string with CRLF and chunk boundaries tolerated. */
export function parseJsonLines<T = unknown>(
  input: Uint8Array | string,
  options: JsonLinesParserOptions<T> = {},
): T[] {
  const parser = new JsonLinesParser<T>(options);
  return [...parser.push(input), ...parser.end()];
}

const EMPTY_LINE = Symbol('empty JSON-lines input');

class BoundedStream {
  private readonly buffer: Buffer;
  private retainedByteCount = 0;
  private observedByteCount = 0;
  private didTruncate = false;

  constructor(
    private readonly maxBytes: number,
    private readonly encoding: BufferEncoding,
  ) {
    this.buffer = Buffer.alloc(maxBytes);
  }

  append(chunk: Uint8Array | string): void {
    const chunkBytes = getChunkByteLength(chunk, this.encoding);
    this.observedByteCount += chunkBytes;
    const remaining = this.maxBytes - this.retainedByteCount;
    if (remaining <= 0) {
      if (chunkBytes > 0) {
        this.didTruncate = true;
      }
      return;
    }

    const retainedBytes = copyChunkPrefix(
      this.buffer,
      this.retainedByteCount,
      chunk,
      remaining,
      this.encoding,
    );
    this.retainedByteCount += retainedBytes;
    if (retainedBytes < chunkBytes) {
      this.didTruncate = true;
    }
  }

  clear(): void {
    this.retainedByteCount = 0;
    this.observedByteCount = 0;
    this.didTruncate = false;
  }

  get text(): string {
    return this.buffer.subarray(0, this.retainedByteCount).toString(this.encoding);
  }

  get totalBytes(): number {
    return this.observedByteCount;
  }

  get retainedBytes(): number {
    return this.retainedByteCount;
  }

  get truncated(): boolean {
    return this.didTruncate;
  }
}

function validateMaxBytes(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer; received ${value}`);
  }
  return value;
}

function validatePositiveMaxBytes(value: number, label: string): number {
  const validated = validateMaxBytes(value, label);
  if (validated === 0) {
    throw new RangeError(`${label} must be greater than zero; received ${value}`);
  }
  return validated;
}

function nextStringChunkEnd(value: string, offset: number, maxBytes: number): number {
  let low = 0;
  let high = value.length - offset;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(offset, offset + middle), 'utf8') <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let end = offset + low;
  if (end < value.length && end > offset) {
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end -= 1;
    }
  }
  if (end !== offset) {
    return end;
  }
  const first = value.charCodeAt(offset);
  const second = value.charCodeAt(offset + 1);
  if (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) {
    return Math.min(offset + 2, value.length);
  }
  return Math.min(offset + 1, value.length);
}

function getChunkByteLength(chunk: Uint8Array | string, encoding: BufferEncoding): number {
  return typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
}

function copyChunkPrefix(
  target: Buffer,
  offset: number,
  chunk: Uint8Array | string,
  maxBytes: number,
  encoding: BufferEncoding,
): number {
  if (typeof chunk !== 'string') {
    const retainedBytes = Math.min(maxBytes, chunk.byteLength);
    target.set(chunk.subarray(0, retainedBytes), offset);
    return retainedBytes;
  }

  const prefix = encodeStringPrefix(chunk, maxBytes, encoding);
  prefix.copy(target, offset);
  return prefix.byteLength;
}

function encodeStringPrefix(value: string, maxBytes: number, encoding: BufferEncoding): Buffer {
  if (maxBytes === 0 || value.length === 0) {
    return Buffer.alloc(0);
  }
  if (Buffer.byteLength(value, encoding) <= maxBytes) {
    return Buffer.from(value, encoding);
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), encoding) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low === 0 ? Buffer.alloc(0) : Buffer.from(value.slice(0, low), encoding);
}

function formatCapturedOutput(output: CapturedOutput): string[] {
  const lines = [
    `stdout (${output.stdoutRetainedBytes}/${output.stdoutTotalBytes} bytes${
      output.stdoutTruncated ? ', truncated' : ''
    }):`,
    limitDiagnosticText(output.stdout),
    `stderr (${output.stderrRetainedBytes}/${output.stderrTotalBytes} bytes${
      output.stderrTruncated ? ', truncated' : ''
    }):`,
    limitDiagnosticText(output.stderr),
  ];
  return lines;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function limitDiagnosticText(text: string, maxBytes = 4_096): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) {
    return text;
  }
  return `${bytes.subarray(0, maxBytes).toString('utf8')}… [diagnostic text truncated]`;
}
