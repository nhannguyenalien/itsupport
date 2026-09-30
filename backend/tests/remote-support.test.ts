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
  { role: 'member', method: 'GET', path: 'devices', suffix: 'remote-support', own: true },
  { role: 'member', method: 'GET', path: 'tickets', suffix: 'takeover-link', own: true },
  { role: 'technician', method: 'PUT', path: 'devices', suffix: 'remote-support', own: true },
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
      headers: { authorization: 'Bearer test' }, ...(scenario.method === 'PUT' ? { payload: { nodeId: 'A'.repeat(64) } } : {}) });
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
