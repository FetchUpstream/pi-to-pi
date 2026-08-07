import { describe, expect, it } from 'vitest';

import { FrameCodecError, FrameDecoder, decodeFrame, encodeFrame } from './frame-codec.js';

describe('local IPC frame codec', () => {
  it('encodes a uint32 big-endian payload length', () => {
    const payload = Buffer.from('hello');
    const encoded = encodeFrame(payload, { maxPayloadBytes: 16 });

    expect(encoded.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 5]));
    expect(encoded.subarray(4)).toEqual(payload);
  });

  it('decodes split headers and bodies without relying on chunk boundaries', () => {
    const encoded = encodeFrame(Buffer.from('{"ok":true}'), { maxPayloadBytes: 64 });
    const decoder = new FrameDecoder({ maxPayloadBytes: 64 });
    const completed: Buffer[] = [];

    for (const byte of encoded) {
      const payload = decoder.push(Buffer.from([byte]));
      if (payload !== undefined) {
        completed.push(payload);
      }
    }

    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual(Buffer.from('{"ok":true}'));
    expect(decoder.finish()).toEqual(completed[0]);
  });

  it('decodes a coalesced header and body as one frame', () => {
    const payload = Buffer.from([0, 1, 2, 3, 4]);
    const decoder = new FrameDecoder({ maxPayloadBytes: payload.length });

    expect(decoder.push(encodeFrame(payload, payload.length))).toEqual(payload);
    expect(decoder.isComplete).toBe(true);
  });

  it('rejects an oversized declaration before allocating a body', () => {
    const decoder = new FrameDecoder({ maxPayloadBytes: 8 });
    const oversizedHeader = Buffer.from([0xff, 0xff, 0xff, 0xff]);

    expect(() => decoder.push(oversizedHeader)).toThrowError(
      expect.objectContaining<Partial<FrameCodecError>>({
        code: 'oversized-frame',
        declaredLength: 0xffffffff,
        maxPayloadBytes: 8,
      }),
    );
    expect(decoder.receivedBytes).toBe(4);
    expect(decoder.isFailed).toBe(true);
  });

  it('rejects oversized payloads at encode time', () => {
    expect(() => encodeFrame(Buffer.alloc(9), { maxPayloadBytes: 8 })).toThrowError(
      expect.objectContaining({ code: 'oversized-frame' }),
    );
  });

  it('rejects truncated headers and bodies at end of stream', () => {
    const headerDecoder = new FrameDecoder({ maxPayloadBytes: 10 });
    headerDecoder.push(Buffer.from([0, 0]));
    expect(() => headerDecoder.finish()).toThrowError(
      expect.objectContaining({ code: 'truncated-frame' }),
    );

    const bodyDecoder = new FrameDecoder({ maxPayloadBytes: 10 });
    bodyDecoder.push(Buffer.from([0, 0, 0, 4, 1, 2]));
    expect(() => bodyDecoder.finish()).toThrowError(
      expect.objectContaining({ code: 'truncated-frame' }),
    );
  });

  it('rejects trailing bytes after the one frame allowed per connection', () => {
    const decoder = new FrameDecoder({ maxPayloadBytes: 8 });

    expect(() => decoder.push(Buffer.from([0, 0, 0, 1, 7, 8]))).toThrowError(
      expect.objectContaining({ code: 'trailing-data' }),
    );
  });

  it('rejects malformed input chunks and decodes exactly one buffered frame', () => {
    const encoded = encodeFrame(Buffer.from('payload'));
    expect(decodeFrame(encoded)).toEqual(Buffer.from('payload'));

    const decoder = new FrameDecoder();
    expect(() => decoder.push('not bytes' as unknown as Uint8Array)).toThrowError(
      expect.objectContaining({ code: 'invalid-chunk' }),
    );
  });
});
