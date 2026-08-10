import { describe, expect, it } from 'vitest';

import {
  FrameCodecError,
  FrameDecoder,
  decodeFrame,
  encodeFrame,
} from '../../src/transport/frame-codec.js';

describe('production local IPC frame codec', () => {
  it('encodes and decodes opaque bytes with a big-endian length', () => {
    const payload = Buffer.from([0, 1, 2, 0xff, 0x00]);
    const encoded = encodeFrame(payload, { maxPayloadBytes: payload.length });

    expect(encoded.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, payload.length]));
    expect(decodeFrame(encoded, payload.length)).toEqual(payload);
  });

  it('handles split headers, split bodies, and coalesced chunks', () => {
    const payload = Buffer.from('split and coalesced');
    const encoded = encodeFrame(payload);
    const decoder = new FrameDecoder();
    const complete: Buffer[] = [];

    for (const chunk of [
      encoded.subarray(0, 1),
      encoded.subarray(1, 4),
      encoded.subarray(4, 9),
      encoded.subarray(9),
    ]) {
      const value = decoder.push(chunk);
      if (value !== undefined) {
        complete.push(value);
      }
    }

    expect(complete).toEqual([payload]);
    expect(decoder.finish()).toEqual(payload);
    expect(new FrameDecoder().push(encodeFrame(payload))).toEqual(payload);
  });

  it('checks oversized declarations before body allocation', () => {
    const decoder = new FrameDecoder({ maxPayloadBytes: 8 });

    expect(() => decoder.push(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toThrowError(
      expect.objectContaining<Partial<FrameCodecError>>({
        code: 'oversized-frame',
        declaredLength: 0xffffffff,
        maxPayloadBytes: 8,
      }),
    );
    expect(decoder.receivedBytes).toBe(4);
    expect(decoder.isFailed).toBe(true);
  });

  it('rejects oversized output, truncation, invalid chunks, and trailing data', () => {
    expect(() => encodeFrame(Buffer.alloc(9), 8)).toThrowError(
      expect.objectContaining({ code: 'oversized-frame' }),
    );

    const header = new FrameDecoder();
    header.push(Buffer.from([0, 0]));
    expect(() => header.finish()).toThrowError(
      expect.objectContaining({ code: 'truncated-frame' }),
    );

    const body = new FrameDecoder();
    body.push(Buffer.from([0, 0, 0, 4, 1, 2]));
    expect(() => body.finish()).toThrowError(expect.objectContaining({ code: 'truncated-frame' }));

    expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 1, 7, 8]))).toThrowError(
      expect.objectContaining({ code: 'trailing-data' }),
    );
    expect(() => new FrameDecoder().push('not bytes' as unknown as Uint8Array)).toThrowError(
      expect.objectContaining({ code: 'invalid-chunk' }),
    );
  });
});
