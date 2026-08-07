/* global process, clearInterval, setInterval */
/**
 * Standalone child-process lifecycle fixture.
 *
 * The fixture deliberately has no package or protocol dependencies. A parent
 * process can launch it with `process.execPath`, wait for the `ready` event,
 * and send one JSON object per line on stdin:
 *
 *   {"command":"shutdown"}
 *   {"command":"hang"}
 *   {"command":"diagnostic","stream":"stdout","message":"..."}
 *   {"command":"diagnostic","stream":"stderr","message":"..."}
 *
 * Lifecycle events are JSON lines on stdout. Diagnostic commands emit `log`
 * events on the requested stream, so stdout and stderr remain independently
 * observable. `LIFECYCLE_FIXTURE_EOL=crlf` (or `--crlf`) makes emitted lines
 * use CRLF for line-ending parser coverage.
 */

const args = new Set(process.argv.slice(2));
const configuredEol = process.env.LIFECYCLE_FIXTURE_EOL?.toLowerCase();
const lineEnding =
  args.has('--crlf') ||
  args.has('--line-ending=crlf') ||
  configuredEol === 'crlf' ||
  configuredEol === 'windows' ||
  process.env.LIFECYCLE_FIXTURE_CRLF === '1' ||
  process.env.LIFECYCLE_FIXTURE_CRLF === 'true'
    ? '\r\n'
    : '\n';

let input = '';
let state = 'running';
let hangTimer;
let currentLineEnding = lineEnding;

function writeLine(stream, value) {
  stream.write(`${JSON.stringify(value)}${currentLineEnding}`);
}

function emit(event, details = {}) {
  writeLine(process.stdout, {
    event,
    type: event,
    ...details,
  });
}

function diagnosticStream(value) {
  return value === 'stderr' ? process.stderr : process.stdout;
}

function diagnosticMessage(command) {
  if (typeof command.message === 'string') {
    return command.message;
  }

  if (typeof command.text === 'string') {
    return command.text;
  }

  if (typeof command.value === 'string') {
    return command.value;
  }

  return '';
}

function normalizeExitCode(value) {
  if (value === undefined) {
    return 0;
  }

  const code = Number(value);
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1;
}

function stopHanging() {
  if (hangTimer !== undefined) {
    clearInterval(hangTimer);
    hangTimer = undefined;
  }
}

function shutdown(command = {}) {
  if (state === 'shutting-down') {
    return;
  }

  state = 'shutting-down';
  stopHanging();
  process.stdin.pause();
  process.stdin.destroy();
  process.stdin.removeListener('data', onData);
  process.stdin.removeListener('end', onEnd);

  const code = normalizeExitCode(command.code);
  emit('exited', {
    code,
    signal: null,
    reason: command.reason ?? 'shutdown',
  });
  process.exitCode = code;
}

function startHanging() {
  if (state === 'shutting-down' || state === 'hanging') {
    return;
  }

  state = 'hanging';
  // Keep one referenced handle alive without doing work. The parent must
  // terminate this process explicitly, which makes timeout tests deterministic.
  hangTimer = setInterval(() => {}, 1_000_000);
  emit('hanging', { reason: 'requested' });
}

function emitDiagnostic(command) {
  const streamName = command.stream === 'stderr' ? 'stderr' : 'stdout';
  writeLine(diagnosticStream(streamName), {
    event: 'log',
    type: 'log',
    stream: streamName,
    message: diagnosticMessage(command),
  });
}

function changeLineEnding(command) {
  const requested = String(command.eol ?? command.lineEnding ?? '').toLowerCase();
  if (requested === 'crlf' || requested === 'windows') {
    currentLineEnding = '\r\n';
  } else if (requested === 'lf' || requested === 'unix') {
    currentLineEnding = '\n';
  }

  emit('line-ending', { lineEnding: currentLineEnding === '\r\n' ? 'crlf' : 'lf' });
}

function commandName(command) {
  const name = command.command ?? command.action ?? command.operation ?? command.type;
  return typeof name === 'string' ? name.toLowerCase() : undefined;
}

function handleCommand(command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    emit('error', { error: 'command_must_be_an_object' });
    return;
  }

  const name = commandName(command);
  switch (name) {
    case 'shutdown':
    case 'stop':
    case 'exit':
      shutdown(command);
      return;
    case 'hang':
    case 'wait':
      startHanging();
      return;
    case 'diagnostic':
    case 'log':
    case 'write':
      emitDiagnostic(command);
      return;
    case 'line-ending':
    case 'set-line-ending':
      changeLineEnding(command);
      return;
    default:
      emit('error', {
        error: 'unknown_command',
        command: name ?? null,
      });
  }
}

function onData(chunk) {
  input += chunk.toString();

  let newlineIndex = input.indexOf('\n');
  while (newlineIndex !== -1) {
    const line = input.slice(0, newlineIndex).replace(/\r$/, '');
    input = input.slice(newlineIndex + 1);
    newlineIndex = input.indexOf('\n');

    if (line.trim() === '') {
      continue;
    }

    try {
      handleCommand(JSON.parse(line));
    } catch (error) {
      emit('error', {
        error: 'invalid_json_command',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function onEnd() {
  // Closing stdin is a useful fallback for a parent that cannot send a final
  // command. A deliberate hang remains alive so timeout tests can terminate it.
  if (state !== 'hanging') {
    shutdown({ reason: 'stdin-closed' });
  }
}

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
process.stdin.on('error', () => {});
process.stdin.setEncoding('utf8');
process.stdin.on('data', onData);
process.stdin.on('end', onEnd);

emit('ready', {
  fixture: 'lifecycle',
  pid: process.pid,
});
