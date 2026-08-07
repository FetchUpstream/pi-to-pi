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
});
