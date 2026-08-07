/**
 * Length-prefixed framing used by the local-IPC spike only.
 *
 * A frame is four bytes containing an unsigned big-endian payload length,
 * followed by exactly that many payload bytes. The decoder is intentionally a
 * one-frame decoder: the spike uses one request or response per connection,
 * so bytes after a complete frame are rejected as trailing input.
 */

export const FRAME_HEADER_BYTES = 4;
export const MAX_UINT32 = 0xffffffff;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

export type FrameCodecErrorCode =
  | 'invalid-max-payload'
  | 'invalid-payload'
  | 'invalid-chunk'
  | 'oversized-frame'
  | 'truncated-frame'
  | 'trailing-data';

export interface FrameCodecOptions {
  readonly maxPayloadBytes?: number;
}

export interface FrameCodecErrorDetails {
  readonly declaredLength?: number;
  readonly maxPayloadBytes?: number;
  readonly receivedBytes?: number;
}

export class FrameCodecError extends Error {
  readonly code: FrameCodecErrorCode;
  readonly declaredLength?: number;
  readonly maxPayloadBytes?: number;
  readonly receivedBytes?: number;

  constructor(code: FrameCodecErrorCode, message: string, details: FrameCodecErrorDetails = {}) {
    super(message);
    this.name = 'FrameCodecError';
    this.code = code;
    this.declaredLength = details.declaredLength;
    this.maxPayloadBytes = details.maxPayloadBytes;
    this.receivedBytes = details.receivedBytes;
  }
}

function invalidMaxPayload(message: string): FrameCodecError {
  return new FrameCodecError('invalid-max-payload', message);
}

/** Validate and normalize a configured maximum before it is used for allocation. */
export function normalizeMaxPayloadBytes(options?: FrameCodecOptions | number): number {
  const configured =
    typeof options === 'number' ? options : (options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES);

  if (!Number.isSafeInteger(configured) || configured < 0 || configured > MAX_UINT32) {
    throw invalidMaxPayload(
      `maxPayloadBytes must be an integer between 0 and ${MAX_UINT32}, got ${String(configured)}`,
    );
  }

  return configured;
}

function asBytes(value: unknown, code: 'invalid-payload' | 'invalid-chunk'): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new FrameCodecError(code, 'Frame data must be a Uint8Array or Buffer');
  }

  return value;
}

/** Encode one bounded payload using a four-byte unsigned big-endian length. */
export function encodeFrame(payload: Uint8Array, options?: FrameCodecOptions | number): Buffer {
  const bytes = asBytes(payload, 'invalid-payload');
  const maxPayloadBytes = normalizeMaxPayloadBytes(options);

  if (bytes.byteLength > maxPayloadBytes) {
    throw new FrameCodecError(
      'oversized-frame',
      `Payload length ${bytes.byteLength} exceeds maximum ${maxPayloadBytes}`,
      { declaredLength: bytes.byteLength, maxPayloadBytes },
    );
  }

  const frame = Buffer.alloc(FRAME_HEADER_BYTES + bytes.byteLength);
  frame.writeUInt32BE(bytes.byteLength, 0);
  frame.set(bytes, FRAME_HEADER_BYTES);
  return frame;
}

/**
 * Incrementally parse a single frame from arbitrary stream chunks.
 *
 * Header bytes are kept in a fixed four-byte buffer. The body is allocated only
 * after the complete declared length has been checked against the configured
 * maximum, so a hostile uint32 declaration cannot trigger an unbounded body
 * allocation.
 */
export class FrameDecoder {
  readonly maxPayloadBytes: number;

  private readonly header = Buffer.alloc(FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;
  private declaredLength: number | undefined;
  private completedPayload: Buffer | undefined;
  private failure: FrameCodecError | undefined;

  constructor(options?: FrameCodecOptions | number) {
    this.maxPayloadBytes = normalizeMaxPayloadBytes(options);
  }

  get isComplete(): boolean {
    return this.completedPayload !== undefined;
  }

  get isFailed(): boolean {
    return this.failure !== undefined;
  }

  get payloadLength(): number | undefined {
    return this.declaredLength;
  }

  /** Number of frame bytes accepted so far (header plus body, excluding trailing input). */
  get receivedBytes(): number {
    return this.headerBytes + this.bodyBytes;
  }

  /**
   * Consume one arbitrary chunk.
   *
   * The return value is the newly completed payload, or undefined while the
   * frame is incomplete. A completed decoder accepts empty chunks but rejects
   * all non-empty trailing input.
   */
  push(chunk: Uint8Array): Buffer | undefined {
    this.throwIfFailed();
    const bytes = asBytes(chunk, 'invalid-chunk');

    if (this.completedPayload !== undefined) {
      if (bytes.byteLength !== 0) {
        throw this.fail(
          'trailing-data',
          `Unexpected ${bytes.byteLength} trailing byte${bytes.byteLength === 1 ? '' : 's'} after frame`,
          { receivedBytes: this.receivedBytes },
        );
      }
      return undefined;
    }

    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.headerBytes < FRAME_HEADER_BYTES) {
        const headerBytesToCopy = Math.min(
          FRAME_HEADER_BYTES - this.headerBytes,
          bytes.byteLength - offset,
        );
        this.header.set(bytes.subarray(offset, offset + headerBytesToCopy), this.headerBytes);
        this.headerBytes += headerBytesToCopy;
        offset += headerBytesToCopy;

        if (this.headerBytes < FRAME_HEADER_BYTES) {
          return undefined;
        }

        const declaredLength = this.header.readUInt32BE(0);
        this.declaredLength = declaredLength;

        // This check MUST happen before Buffer.alloc(declaredLength).
        if (declaredLength > this.maxPayloadBytes) {
          throw this.fail(
            'oversized-frame',
            `Declared payload length ${declaredLength} exceeds maximum ${this.maxPayloadBytes}`,
            { declaredLength, maxPayloadBytes: this.maxPayloadBytes },
          );
        }

        this.body = Buffer.alloc(declaredLength);
        if (declaredLength === 0) {
          this.completedPayload = this.body;
          if (offset < bytes.byteLength) {
            throw this.fail(
              'trailing-data',
              `Unexpected ${bytes.byteLength - offset} trailing byte${bytes.byteLength - offset === 1 ? '' : 's'} after frame`,
              { receivedBytes: this.receivedBytes },
            );
          }
          return this.completedPayload;
        }
      }

      const body = this.body;
      const declaredLength = this.declaredLength;
      if (body === undefined || declaredLength === undefined) {
        throw this.fail('truncated-frame', 'Decoder entered an invalid body state');
      }

      const bodyBytesToCopy = Math.min(declaredLength - this.bodyBytes, bytes.byteLength - offset);
      body.set(bytes.subarray(offset, offset + bodyBytesToCopy), this.bodyBytes);
      this.bodyBytes += bodyBytesToCopy;
      offset += bodyBytesToCopy;

      if (this.bodyBytes === declaredLength) {
        this.completedPayload = body;
        if (offset < bytes.byteLength) {
          throw this.fail(
            'trailing-data',
            `Unexpected ${bytes.byteLength - offset} trailing byte${bytes.byteLength - offset === 1 ? '' : 's'} after frame`,
            { receivedBytes: this.receivedBytes },
          );
        }
        return this.completedPayload;
      }
    }

    return undefined;
  }

  /** Alias useful at call sites that use stream terminology. */
  feed(chunk: Uint8Array): Buffer | undefined {
    return this.push(chunk);
  }

  /** Finish the stream and reject a missing or partial header/body. */
  finish(): Buffer {
    this.throwIfFailed();
    if (this.completedPayload !== undefined) {
      return this.completedPayload;
    }

    const expectedBytes =
      this.declaredLength === undefined
        ? FRAME_HEADER_BYTES
        : FRAME_HEADER_BYTES + this.declaredLength;
    throw this.fail(
      'truncated-frame',
      `Frame ended after ${this.receivedBytes} of ${expectedBytes} expected byte${expectedBytes === 1 ? '' : 's'}`,
      { receivedBytes: this.receivedBytes },
    );
  }

  private throwIfFailed(): void {
    if (this.failure !== undefined) {
      throw this.failure;
    }
  }

  private fail(
    code: FrameCodecErrorCode,
    message: string,
    details: FrameCodecErrorDetails = {},
  ): FrameCodecError {
    const error = new FrameCodecError(code, message, details);
    this.failure = error;
    return error;
  }
}

export { FrameDecoder as IncrementalFrameDecoder };

export function createFrameDecoder(options?: FrameCodecOptions | number): FrameDecoder {
  return new FrameDecoder(options);
}

/** Decode exactly one complete frame from an already-buffered byte sequence. */
export function decodeFrame(encoded: Uint8Array, options?: FrameCodecOptions | number): Buffer {
  const decoder = new FrameDecoder(options);
  decoder.push(encoded);
  return decoder.finish();
}
