import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { remoteConsoleUrl } from './links.js';

export function meshConfigured(): boolean {
  return !!(remoteConsoleUrl() && process.env.MESHCENTRAL_API_USER && process.env.MESHCENTRAL_API_PASSWORD);
}

// Credentials remain on the backend. Each bounded request uses a fresh socket;
// no command, link, or authentication header is written to logs.
export async function meshCommand(command: Record<string, unknown>): Promise<Record<string, any>> {
  const base = remoteConsoleUrl();
  if (!base || !meshConfigured()) throw Object.assign(new Error('Remote support unavailable'), { statusCode: 503 });
  const url = new URL('/control.ashx', base); url.protocol = 'wss:';
  return new Promise((resolve, reject) => {
    const responseid = randomUUID();
    const socket = new WebSocket(url, { handshakeTimeout: 10000, maxPayload: 4 * 1024 * 1024,
      headers: { 'x-meshauth': Buffer.from(process.env.MESHCENTRAL_API_USER!).toString('base64') + ',' + Buffer.from(process.env.MESHCENTRAL_API_PASSWORD!).toString('base64') } });
    let settled = false;
    const finish = (error?: Error, value?: Record<string, any>) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.close();
      if (error) reject(Object.assign(error, { statusCode: 503 })); else resolve(value!);
    };
    const timer = setTimeout(() => { finish(new Error('Remote support timed out')); socket.terminate(); }, 15000);
    socket.on('error', () => finish(new Error('Remote support connection failed')));
    socket.on('close', () => finish(new Error('Remote support disconnected')));
    socket.on('message', raw => {
      let data; try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.action === 'userinfo') socket.send(JSON.stringify({ ...command, responseid }));
      // deviceShares in MeshCentral 1.2.5 omits responseid. Each socket carries one request.
      if (data.responseid !== responseid && !(command.action === 'deviceShares' && data.action === 'deviceShares' && data.nodeid === 'node//' + command.nodeid)) return;
      if (data.result && data.result !== 'OK') finish(new Error('Remote support request failed'));
      else finish(undefined, data);
    });
  });
}

// Injectable transport for deterministic access-control and revocation tests.
export const meshTransport = { command: meshCommand };
