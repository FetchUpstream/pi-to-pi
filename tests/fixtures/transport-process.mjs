/* global Buffer, clearInterval, clearTimeout, process, setInterval, setTimeout */

/*
 * Standalone native local-IPC fixture for process-boundary tests.
 *
 * It intentionally carries only opaque framed bytes and a JSON-lines control
 * channel for the test harness. It is not the package transport or a Pi wire
 * protocol implementation.
 */

import { createConnection, createServer } from 'node:net';
import { createInterface } from 'node:readline';

const [role, endpoint] = process.argv.slice(2);
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const argsValid = (role === 'server' || role === 'client') && typeof endpoint === 'string';
let shuttingDown = false;
let server;
const sockets = new Set();

function emit(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, type: event, ...details })}\n`);
}

function encodeFrame(payload) {
  if (!Buffer.isBuffer(payload) || payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error('fixture payload exceeds maximum');
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function decodeFrame(buffer) {
  if (buffer.byteLength < 4) {
    return undefined;
  }
  const length = buffer.readUInt32BE(0);
  if (length > MAX_PAYLOAD_BYTES) {
    throw new Error('oversized frame');
  }
  if (buffer.byteLength < 4 + length) {
    return undefined;
  }
  if (buffer.byteLength > 4 + length) {
    throw new Error('trailing frame data');
  }
  return buffer.subarray(4);
}

function fromBase64(value) {
  if (typeof value !== 'string') {
    throw new Error('payload must be base64');
  }
  return Buffer.from(value, 'base64');
}

function closeSocket(socket) {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function closeServer() {
  if (server === undefined || !server.listening) {
    return Promise.resolve();
  }
  for (const socket of sockets) {
    closeSocket(socket);
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

function responseFor(payload) {
  const text = payload.toString('utf8');
  if (text === 'silent') {
    return undefined;
  }
  if (text === 'drip-header') {
    return { payload: Buffer.from('header'), dripMs: 25 };
  }
  if (text === 'drip-body') {
    return { payload: Buffer.from('body'), dripMs: 10 };
  }
  if (text.startsWith('drip:')) {
    return { payload: Buffer.from(text.slice(5)), dripMs: 10 };
  }
  if (text === 'malformed-response') {
    return { raw: Buffer.from([0, 0, 0, 1, 0x61, 0x62]) };
  }
  if (text === 'truncated-response') {
    return { raw: Buffer.from([0, 0, 0, 4, 0x7b]) };
  }
  if (text === 'oversized-response') {
    return { raw: Buffer.from([0xff, 0xff, 0xff, 0xff]) };
  }
  return { payload: Buffer.from(payload).reverse() };
}

function handleServerSocket(socket) {
  sockets.add(socket);
  socket.on('error', () => undefined);
  socket.once('close', () => sockets.delete(socket));
  let input = Buffer.alloc(0);
  let handled = false;
  let dripTimer;

  const fail = (message) => {
    if (dripTimer !== undefined) {
      clearInterval(dripTimer);
      dripTimer = undefined;
    }
    closeSocket(socket);
    emit('connection-error', { message });
  };

  socket.on('data', (chunk) => {
    if (handled || socket.destroyed) {
      fail('unexpected trailing data');
      return;
    }
    input = Buffer.concat([input, chunk]);
    try {
      const payload = decodeFrame(input);
      if (payload === undefined) {
        return;
      }
      handled = true;
      const response = responseFor(payload);
      if (response === undefined) {
        return;
      }
      if (response.raw !== undefined) {
        socket.end(response.raw);
        return;
      }
      const frame = encodeFrame(response.payload);
      if (response.dripMs === undefined) {
        socket.end(frame);
        return;
      }
      let offset = 0;
      dripTimer = setInterval(() => {
        if (socket.destroyed || offset >= frame.byteLength) {
          clearInterval(dripTimer);
          dripTimer = undefined;
          if (!socket.destroyed) {
            closeSocket(socket);
          }
          return;
        }
        socket.write(frame.subarray(offset, offset + 1));
        offset += 1;
      }, response.dripMs);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });
  socket.once('end', () => {
    if (!handled) {
      fail('truncated frame');
    }
  });
}

async function startServer() {
  server = createServer({ allowHalfOpen: true }, handleServerSocket);
  server.on('error', (error) => emit('server-error', { message: error.message }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  emit('ready', { role, endpoint });
}

function request(command) {
  let socket;
  let timer;
  let input = Buffer.alloc(0);
  let settled = false;
  const id = command.id ?? null;
  const settle = (event, details = {}) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    socket?.destroy();
    emit(event, { id, ...details });
  };

  try {
    const bytes =
      command.raw === true ? fromBase64(command.payload) : encodeFrame(fromBase64(command.payload));
    socket = createConnection(endpoint);
    socket.on('error', (error) => settle('request-error', { message: error.message }));
    socket.once('close', () => {
      if (!settled) {
        settle('request-error', { message: 'peer closed before response' });
      }
    });
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      try {
        const payload = decodeFrame(input);
        if (payload !== undefined) {
          settle('response', { payload: payload.toString('base64') });
        }
      } catch (error) {
        settle('request-error', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    timer = setTimeout(
      () => settle('request-error', { message: 'request deadline exceeded' }),
      command.timeoutMs ?? 1_000,
    );
    socket.once('connect', () => {
      socket.write(bytes, () => {
        if (command.abortAfterMs !== undefined) {
          setTimeout(() => closeSocket(socket), command.abortAfterMs);
        }
      });
    });
  } catch (error) {
    settle('request-error', { message: error instanceof Error ? error.message : String(error) });
  }
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await closeServer();
  process.stdin.pause();
  process.stdin.destroy();
  emit('exited', { code: 0, signal: null });
}

if (!argsValid) {
  emit('error', { message: 'invalid fixture arguments' });
  process.exitCode = 1;
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (shuttingDown || line.trim() === '') {
      return;
    }
    let command;
    try {
      command = JSON.parse(line);
    } catch (error) {
      emit('error', { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const name = command.command ?? command.action;
    if (name === 'shutdown' || name === 'stop' || name === 'exit') {
      void shutdown();
    } else if (role === 'client' && name === 'request') {
      request(command);
    } else {
      emit('error', { message: `unknown command: ${String(name)}` });
    }
  });
  input.on('close', () => {
    if (!shuttingDown) {
      void shutdown();
    }
  });
  if (role === 'server') {
    void startServer().catch((error) => {
      emit('server-error', { message: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    });
  } else {
    emit('ready', { role, endpoint });
  }
}
