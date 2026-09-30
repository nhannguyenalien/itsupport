import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import Fastify from 'fastify';
import { meshNodeId, remoteDeviceUrl } from '../src/remote-support/links.js';

process.env.DATABASE_URL ||= 'postgres://localhost/remote_test';
process.env.FIREBASE_PROJECT_ID ||= 'remote-test';
const { adminPool, pool } = await import('../src/db/pool.js');
const { firebaseAuth } = await import('../src/auth/firebase.js');
const { registerAuth } = await import('../src/auth/plugin.js');
const { deviceRoutes } = await import('../src/devices/routes.js');
const { ticketRoutes } = await import('../src/tickets/routes.js');
const device = '11111111-1111-4111-8111-111111111111';

test('MeshCentral links preserve modified base64 IDs and reject arbitrary destinations', () => {
  process.env.MESHCENTRAL_URL = 'https://mesh.example.test';
  const id = '@$' + 'A'.repeat(62);
  const url = new URL(remoteDeviceUrl(id));
  assert.equal(url.origin, 'https://mesh.example.test');
  assert.equal(url.searchParams.get('gotonode'), id);
  assert.equal(url.searchParams.get('viewmode'), '11');
  for (const value of ['https://evil.test', '../other', '', 'node//abc']) assert.equal(meshNodeId.safeParse(value).success, false);
});

for (const scenario of [
  { role: 'member', method: 'GET', path: 'tickets', suffix: 'takeover-link', own: true },
  { role: 'admin', method: 'PUT', path: 'devices', suffix: 'remote-support', own: false },
  { role: 'admin', method: 'GET', path: 'devices', suffix: 'remote-support', own: false },
] as const) test(`${scenario.role} ${scenario.method} ${scenario.path} own=${scenario.own} is denied`, async () => {
  mock.method(firebaseAuth, 'verifyIdToken', async () => ({ uid: 'user', email_verified: true }));
  mock.method(adminPool, 'query', async () => ({ rows: [{ id: 'user', tenant_id: 'tenant', role: scenario.role }] }));
  let writes = 0;
  mock.method(pool, 'query', async (sql: string) => {
    if (sql.startsWith('SELECT 1')) return { rows: [], rowCount: scenario.own ? 1 : 0 };
    writes++; throw new Error('Should not access remote configuration');
  });
  const app = Fastify();
  await registerAuth(app); await deviceRoutes(app); await ticketRoutes(app);
  try {
    const result = await app.inject({ method: scenario.method, url: `/${scenario.path}/${device}/${scenario.suffix}`,
      headers: { authorization: 'Bearer test' }, ...(scenario.method === 'PUT' ? { payload: { enabled: true } } : {}) });
    assert.ok([403, 404].includes(result.statusCode), result.body);
    assert.equal(writes, 0);
  } finally { await app.close(); mock.restoreAll(); }
});

const { remoteInstall } = await import('../src/remote-support/install.js');
const tenant = '22222222-2222-4222-8222-222222222222';
test('installer uses only the authenticated tenant group and HTTPS', () => {
  process.env.MESHCENTRAL_URL = 'https://mesh.example.test';
  process.env.MESHCENTRAL_TENANT_GROUPS = JSON.stringify({ [tenant]: '@$' + 'A'.repeat(62) });
  assert.equal(remoteInstall(device, 'mac'), null);
  const config = remoteInstall(tenant, 'mac')!;
  assert.equal(new URL(config.url).searchParams.get('meshid'), '@$' + 'A'.repeat(62));
  assert.equal(new URL(config.url).searchParams.get('id'), '10005');
  assert.equal(new URL(remoteInstall(tenant, 'windows')!.url).searchParams.get('id'), '4');
  process.env.MESHCENTRAL_URL = 'http://mesh.example.test';
  assert.throws(() => remoteInstall(tenant, 'mac'));
});

for (const valid of [false, true]) test(`remote installer enforces active device credential: ${valid}`, async () => {
  process.env.MESHCENTRAL_URL = 'https://mesh.example.test';
  process.env.MESHCENTRAL_TENANT_GROUPS = JSON.stringify({ [tenant]: 'A'.repeat(64) });
  mock.method(adminPool, 'query', async (sql: string, params: unknown[]) => {
    assert.match(sql, /cert_revoked_at IS NULL/);
    assert.match(sql, /AND id = \$2/);
    assert.equal(params[1], device);
    return { rows: valid ? [{ id: device, tenant_id: tenant }] : [], rowCount: valid ? 1 : 0 };
  });
  mock.method(pool, 'query', async () => ({ rows: [{ platform: 'mac' }], rowCount: 1 }));
  const app = Fastify();
  await registerAuth(app); await deviceRoutes(app);
  try {
    const result = await app.inject({ url: `/devices/${device}/remote-install`, headers: { authorization: 'Bearer agent' } });
    assert.equal(result.statusCode, valid ? 200 : 401, result.body);
    if (valid) assert.equal(result.headers['cache-control'], 'no-store');
  } finally { await app.close(); mock.restoreAll(); }
});

const { meshTransport } = await import('../src/remote-support/client.js');
const { normalizeNodeId, verifyNode, activeShare, shareUrl } = await import('../src/remote-support/access.js');
test('remote identity conversion and tenant group isolation', async () => {
  process.env.MESHCENTRAL_URL = 'https://mesh.example.test';
  process.env.MESHCENTRAL_TENANT_GROUPS = JSON.stringify({ [tenant]: 'A'.repeat(64) });
  assert.equal(normalizeNodeId('ff'.repeat(48)), '$'.repeat(64));
  mock.method(meshTransport, 'command', async () => ({ nodes: { ['mesh//' + 'B'.repeat(64)]: [{ _id: 'node//' + 'C'.repeat(64) }] } }));
  try { await assert.rejects(verifyNode(tenant, 'C'.repeat(64)), /not registered/); }
  finally { mock.restoreAll(); }
  assert.equal(activeShare([{ startTime: 1, expireTime: 2 }], 3), undefined);
  assert.throws(() => shareUrl('https://evil.test/sharing?c=x'));
  assert.throws(() => shareUrl('https://mesh.example.test/'));
});

for (const platform of ['mac', 'windows', 'linux']) for (const role of ['member', 'technician', 'admin']) test(`${platform} ${role} can enable and revoke support, with private links restricted`, async () => {
  process.env.MESHCENTRAL_URL = 'https://mesh.example.test';
  process.env.MESHCENTRAL_API_USER = 'api'; process.env.MESHCENTRAL_API_PASSWORD = 'test';
  process.env.MESHCENTRAL_TENANT_GROUPS = JSON.stringify({ [tenant]: 'A'.repeat(64) });
  const nodeId = 'C'.repeat(64);
  let shares: any[] = [];
  let creates = 0, removes = 0;
  mock.method(firebaseAuth, 'verifyIdToken', async () => ({ uid: 'user', email_verified: true }));
  mock.method(adminPool, 'query', async () => ({ rows: [{ id: device, tenant_id: tenant, role }] }));
  mock.method(adminPool, 'connect', async () => ({ query: async () => ({ rows: [{ acquired: true }] }), release() {} }));
  mock.method(pool, 'query', async (sql: string) => {
    if (sql.startsWith('SELECT 1')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('meshcentral_device_id')) return { rows: [{ platform, meshcentral_device_id: nodeId, cert_revoked_at: null }], rowCount: 1 };
    if (sql.includes('audit')) return { rows: [], rowCount: 1 };
    throw new Error('Unexpected SQL: ' + sql);
  });
  mock.method(meshTransport, 'command', async (command: any) => {
    if (command.action === 'nodes') return { nodes: { ['mesh//' + 'A'.repeat(64)]: [{ _id: 'node//' + nodeId }] } };
    if (command.action === 'deviceShares') return { deviceShares: shares };
    if (command.action === 'createDeviceShareLink') {
      assert.equal(command.p, platform === 'linux' ? 1 : 3); assert.equal(command.consent, platform === 'linux' ? 0 : 88); assert.equal(command.expire, 60);
      creates++;
      shares = [{ guestName: 'ITSupport:' + device, publicid: 'share', startTime: Date.now() - 100, expireTime: Date.now() + 3600000, url: 'https://mesh.example.test/sharing?c=test' }];
      return { result: 'OK' };
    }
    if (command.action === 'removeDeviceShare') { assert.equal(command.publicid, 'share'); removes++; shares = []; return { result: 'OK' }; }
    throw new Error('Unexpected command');
  });
  const app = Fastify(); await registerAuth(app); await deviceRoutes(app);
  const toggle = (enabled: boolean) => app.inject({ method: 'PUT', url: `/devices/${device}/remote-support`, headers: { authorization: 'Bearer test' }, payload: { enabled } });
  try {
    const on = await toggle(true); assert.equal(on.statusCode, 200, on.body); assert.equal(on.json().enabled, true);
    assert.equal(!!on.json().url, role !== 'member');
    assert.equal(on.json().mode, platform === 'linux' ? 'terminal' : 'desktop-terminal');
    assert.equal((await toggle(true)).statusCode, 200); assert.equal(creates, 1);
    const off = await toggle(false); assert.equal(off.statusCode, 200, off.body); assert.equal(off.json().enabled, false); assert.equal(off.json().url, null); assert.equal(removes, 1);
    assert.equal((await toggle(false)).statusCode, 200); assert.equal(removes, 1);
  } finally { await app.close(); mock.restoreAll(); }
});

test('Linux downloads select the correct architecture and tenant settings', () => {
  process.env.MESHCENTRAL_URL = 'https://mesh.example.test';
  const group = '@$' + 'A'.repeat(62);
  process.env.MESHCENTRAL_TENANT_GROUPS = JSON.stringify({ [tenant]: group });
  for (const [arch, id] of [['amd64', '6'], ['arm64', '26']] as const) {
    const config = remoteInstall(tenant, 'linux', arch)!;
    assert.equal(new URL(config.url).searchParams.get('id'), id);
    assert.equal(new URL(config.settingsUrl).searchParams.get('id'), group);
    assert.equal(new URL(config.settingsUrl).origin, 'https://mesh.example.test');
    assert.equal(remoteInstall(device, 'linux', arch), null);
  }
  assert.throws(() => remoteInstall(tenant, 'linux'), /architecture/);
  assert.throws(() => remoteInstall(tenant, 'unknown'), /Unsupported/);
});
