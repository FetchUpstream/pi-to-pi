/**
 * The sole production implementation of the local-IPC frame format.
 *
 * A frame is one four-byte unsigned big-endian payload length followed by the
 * exact payload bytes. The decoder accepts arbitrary stream chunks and only
 * allocates a body after checking the declared length against the configured
 * maximum.
 */

import { DEFAULT_MAX_PAYLOAD_BYTES } from './transport.js';

export const FRAME_HEADER_BYTES = 4;
export const MAX_UINT32 = 0xffffffff;

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
  public readonly code: FrameCodecErrorCode;
  public readonly declaredLength: number | undefined;
  public readonly maxPayloadBytes: number | undefined;
  public readonly receivedBytes: number | undefined;

  public constructor(
    code: FrameCodecErrorCode,
    message: string,
    details: FrameCodecErrorDetails = {},
  ) {
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

/** Validate a configured maximum before it is used for an allocation. */
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

/** Incrementally decode exactly one frame from arbitrary byte-stream chunks. */
export class FrameDecoder {
  public readonly maxPayloadBytes: number;

  private readonly header = Buffer.alloc(FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private body: Buffer | undefined;
  private bodyBytes = 0;
  private declaredLength: number | undefined;
  private completedPayload: Buffer | undefined;
  private failure: FrameCodecError | undefined;

  public constructor(options?: FrameCodecOptions | number) {
    this.maxPayloadBytes = normalizeMaxPayloadBytes(options);
  }

  public get isComplete(): boolean {
    return this.completedPayload !== undefined;
  }

  public get isFailed(): boolean {
    return this.failure !== undefined;
  }

  public get payloadLength(): number | undefined {
    return this.declaredLength;
  }

  /** Number of accepted header/body bytes, excluding rejected trailing bytes. */
  public get receivedBytes(): number {
    return this.headerBytes + this.bodyBytes;
  }

  /** Consume one arbitrary stream chunk. */
  public push(chunk: Uint8Array): Buffer | undefined {
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
        if (declaredLength > this.maxPayloadBytes) {
          throw this.fail(
            'oversized-frame',
            `Declared payload length ${declaredLength} exceeds maximum ${this.maxPayloadBytes}`,
            { declaredLength, maxPayloadBytes: this.maxPayloadBytes },
          );
        }

        // The declaration is checked before this allocation.
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

  public feed(chunk: Uint8Array): Buffer | undefined {
    return this.push(chunk);
  }

  /** Finish the stream and reject a missing or partial header/body. */
  public finish(): Buffer {
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

/** Decode exactly one complete frame from an already-buffered sequence. */
export function decodeFrame(encoded: Uint8Array, options?: FrameCodecOptions | number): Buffer {
  const decoder = new FrameDecoder(options);
  decoder.push(encoded);
  return decoder.finish();
}
