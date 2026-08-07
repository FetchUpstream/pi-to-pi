import { describe, expect, it } from 'vitest';

import { BoundedOutput, JsonLinesParseError, JsonLinesParser, parseJsonLines } from './output.js';

describe('bounded process output support', () => {
  it('bounds stdout and stderr independently', () => {
    const output = new BoundedOutput({ maxStdoutBytes: 4, maxStderrBytes: 3 });

    output.appendStdout('stdout');
    output.appendStderr('stderr');

    expect(output.snapshot()).toEqual({
      stdout: 'stdo',
      stderr: 'std',
      stdoutBytes: 6,
      stderrBytes: 6,
      stdoutTotalBytes: 6,
      stderrTotalBytes: 6,
      stdoutRetainedBytes: 4,
      stderrRetainedBytes: 3,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
  });

  it('parses CRLF events across chunks and accepts an unterminated final line', () => {
    const parser = new JsonLinesParser<{ type: string; value?: number }>({
      identity: { label: 'fixture-a', pid: 123 },
    });

    expect(parser.push('{"type":"ready"}\r\n{"type":"value",')).toEqual([{ type: 'ready' }]);
    expect(parser.push('"value":42}\r\n')).toEqual([{ type: 'value', value: 42 }]);
    expect(parser.push('{"type":"done"}')).toEqual([]);
    expect(parser.end()).toEqual([{ type: 'done' }]);
    expect(parser.end()).toEqual([]);
  });

  it('includes process identity and captured output in parse failures', () => {
    const output = new BoundedOutput();
    output.appendStdout('ready\r\n');
    output.appendStderr('fixture diagnostics');

    expect(() =>
      parseJsonLines('{"type":"ready"}\r\nnot-json\r\n', {
        identity: { label: 'fixture-b', pid: 456 },
        getOutput: () => output.snapshot(),
      }),
    ).toThrowError(JsonLinesParseError);

    try {
      parseJsonLines('not-json\r\n', {
        identity: { label: 'fixture-b', pid: 456 },
        output: output.snapshot(),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(JsonLinesParseError);
      expect(String(error)).toContain('fixture-b (pid 456)');
      expect(String(error)).toContain('fixture diagnostics');
      expect(String(error)).toContain('ready');
    }
  });
  it('checks line bounds before ignoring oversized whitespace lines', () => {
    expect(() =>
      parseJsonLines(`${' '.repeat(9)}\n`, {
        maxLineBytes: 8,
        identity: 'whitespace-fixture',
      }),
    ).toThrowError(/line exceeds 8 bytes/);
  });

  it('processes large input chunks in bounded parser slices', () => {
    const parser = new JsonLinesParser<{ value: number }>({ maxChunkBytes: 4 });

    expect(parser.push('{"value":1}\n{"value":2}\n')).toEqual([{ value: 1 }, { value: 2 }]);
    const unicodeParser = new JsonLinesParser<{ value: string }>({ maxChunkBytes: 1 });
    expect(unicodeParser.push('{"value":"😀"}\n')).toEqual([{ value: '😀' }]);
  });

  it('retains only a bounded prefix of an oversized multibyte output chunk', () => {
    const output = new BoundedOutput({ maxStdoutBytes: 4 });

    output.appendStdout('😀😀');

    expect(output.snapshot()).toMatchObject({
      stdout: '😀',
      stdoutTotalBytes: 8,
      stdoutRetainedBytes: 4,
      stdoutTruncated: true,
    });
  });
});
