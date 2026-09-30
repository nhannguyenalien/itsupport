import { adminPool, queryTenantScoped } from '../db/pool.js';
import { meshTransport, meshConfigured } from './client.js';
import { meshNodeId, remoteConsoleUrl } from './links.js';
import { remoteInstall } from './install.js';

export function normalizeNodeId(value: string): string {
  const id = meshNodeId.parse(value);
  return /^[a-fA-F0-9]{96}$/.test(id) ? Buffer.from(id, 'hex').toString('base64').replaceAll('+', '@').replaceAll('/', '$') : id;
}
export async function verifyNode(tenantId: string, nodeId: string): Promise<void> {
  const group = remoteInstall(tenantId, 'mac')?.group;
  if (!group) throw Object.assign(new Error('Remote support unavailable'), { statusCode: 503 });
  const result = await meshTransport.command({ action: 'nodes', meshid: 'mesh//' + group });
  const nodes = result.nodes?.['mesh//' + group];
  if (!Array.isArray(nodes) || !nodes.some(n => n._id === 'node//' + nodeId)) {
    throw Object.assign(new Error('Remote agent is not registered in this workspace'), { statusCode: 409 });
  }
}
export async function withRemoteLock<T>(deviceId: string, run: () => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', ['remote-support:' + deviceId]);
    if (!lock.rows[0].acquired) throw Object.assign(new Error('Remote support is updating; retry'), { statusCode: 409 });
    return await run();
  } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
}
export async function remoteDevice(tenantId: string, deviceId: string) {
  const result = await queryTenantScoped(tenantId, 'SELECT meshcentral_device_id, cert_revoked_at FROM devices WHERE id = $1', [deviceId]);
  if (!result.rows[0]) throw Object.assign(new Error('Device not found'), { statusCode: 404 });
  return result.rows[0];
}
export async function supportShares(nodeId: string, deviceId: string) {
  const result = await meshTransport.command({ action: 'deviceShares', nodeid: nodeId });
  if (!Array.isArray(result.deviceShares)) throw new Error('Invalid remote support response');
  return result.deviceShares.filter((s: any) => s.guestName === 'ITSupport:' + deviceId);
}
export function activeShare(shares: any[], now = Date.now()) {
  return shares.find(s => s.startTime <= now && s.expireTime > now);
}
export function shareUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== remoteConsoleUrl() || url.pathname !== '/sharing') throw new Error('Invalid support URL');
  return url.toString();
}
export async function remoteStatus(tenantId: string, deviceId: string, technician: boolean) {
  const device = await remoteDevice(tenantId, deviceId);
  const ready = meshConfigured() && !!device.meshcentral_device_id && !device.cert_revoked_at;
  if (!ready) return { ready: false, enabled: false, expiresAt: null, url: null };
  await verifyNode(tenantId, normalizeNodeId(device.meshcentral_device_id));
  const share = activeShare(await supportShares(normalizeNodeId(device.meshcentral_device_id), deviceId));
  return { ready: true, enabled: !!share, expiresAt: share ? new Date(share.expireTime).toISOString() : null,
    url: share && technician ? shareUrl(share.url) : null };
}
