/* global console, process */
import { createServer } from 'node:net';

const endpoint = process.argv[2];
if (typeof endpoint !== 'string' || endpoint.length === 0) {
  console.error('missing endpoint');
  process.exit(2);
}

const server = createServer((socket) => {
  socket.resume();
});
server.on('error', (error) => {
  console.error(error);
  process.exitCode = 3;
});
server.listen(endpoint, () => {
  process.stdout.write('READY\n');
});
