import net from 'net';
import { Buffer } from 'buffer';
import { randomUUID } from 'crypto';

// IPC protocol: 4-byte UInt32BE length prefix + JSON payload
function encodeMessage(msg) {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, 'utf8');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function decodeMessages(buf) {
  const messages = [];
  let offset = 0;
  while (buf.length - offset >= 4) {
    const len = buf.readUInt32BE(offset);
    if (buf.length - offset < 4 + len) break;
    const json = buf.subarray(offset + 4, offset + 4 + len).toString('utf8');
    messages.push(JSON.parse(json));
    offset += 4 + len;
  }
  return messages;
}

const pipeName = '\\\\.\\pipe\\brain';
const routes = process.argv.slice(2);
if (routes.length === 0) routes.push('orchestrator.summary');

const client = net.connect(pipeName, () => {
  for (const route of routes) {
    const msg = { id: randomUUID(), type: 'request', method: route, params: {} };
    client.write(encodeMessage(msg));
  }
});

let buf = Buffer.alloc(0);
let received = 0;
client.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  const messages = decodeMessages(buf);
  for (const msg of messages) {
    received++;
    console.log(`\n=== ${msg.method ?? routes[received-1] ?? 'response'} ===`);
    console.log(JSON.stringify(msg.result ?? msg.error ?? msg, null, 2));
  }
  if (received >= routes.length) {
    client.destroy();
  }
});

client.setTimeout(10000);
client.on('timeout', () => { console.log('TIMEOUT after 10s'); client.destroy(); });
client.on('error', (err) => { console.error('ERROR:', err.message); });
